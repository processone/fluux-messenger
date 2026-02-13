#!/usr/bin/env node
/**
 * Rename release assets to consistent user-friendly names and update latest.json
 *
 * Usage: node scripts/rename-release-assets.js <tag>
 * Requires: GITHUB_TOKEN environment variable
 */

import https from 'https';

const OWNER = 'processone';
const REPO = 'fluux-messenger';

// Mapping from old naming patterns to new names
// Uses regex patterns to match and extract version
function getNewName(oldName, version) {
  const v = version.replace(/^v/, '');

  const mappings = [
    // macOS DMG
    { pattern: /^Fluux\.Messenger_[\d.]+_aarch64\.dmg$/, newName: `Fluux-Messenger_${v}_macOS_arm64.dmg` },
    { pattern: /^Fluux\.Messenger_[\d.]+_x64\.dmg$/, newName: `Fluux-Messenger_${v}_macOS_x64.dmg` },

    // macOS app.tar.gz (updater)
    { pattern: /^Fluux\.Messenger_aarch64\.app\.tar\.gz$/, newName: `Fluux-Messenger_${v}_macOS_arm64.app.tar.gz` },
    { pattern: /^Fluux\.Messenger_x64\.app\.tar\.gz$/, newName: `Fluux-Messenger_${v}_macOS_x64.app.tar.gz` },
    { pattern: /^Fluux\.Messenger_aarch64\.app\.tar\.gz\.sig$/, newName: `Fluux-Messenger_${v}_macOS_arm64.app.tar.gz.sig` },
    { pattern: /^Fluux\.Messenger_x64\.app\.tar\.gz\.sig$/, newName: `Fluux-Messenger_${v}_macOS_x64.app.tar.gz.sig` },

    // Windows
    { pattern: /^Fluux\.Messenger_[\d.]+_x64-setup\.exe$/, newName: `Fluux-Messenger_${v}_Windows_x64-setup.exe` },
    { pattern: /^Fluux\.Messenger_[\d.]+_x64-setup\.exe\.sig$/, newName: `Fluux-Messenger_${v}_Windows_x64-setup.exe.sig` },
    { pattern: /^Fluux\.Messenger_[\d.]+_x64_en-US\.msi$/, newName: `Fluux-Messenger_${v}_Windows_x64.msi` },
    { pattern: /^Fluux\.Messenger_[\d.]+_x64_en-US\.msi\.sig$/, newName: `Fluux-Messenger_${v}_Windows_x64.msi.sig` },

    // Linux DEB - fix the double architecture issue
    { pattern: /^fluux-messenger_[\d.]+-\d+_amd64.*\.deb$/, newName: `Fluux-Messenger_${v}_Linux_x64.deb` },
    { pattern: /^fluux-messenger_[\d.]+-\d+_arm64.*\.deb$/, newName: `Fluux-Messenger_${v}_Linux_arm64.deb` },

    // Linux RPM (built with rpmbuild, not Tauri)
    { pattern: /^fluux-messenger-[\d.]+-\d+\.x86_64\.rpm$/, newName: `Fluux-Messenger_${v}_Linux_x64.rpm` },
    { pattern: /^fluux-messenger-[\d.]+-\d+\.aarch64\.rpm$/, newName: `Fluux-Messenger_${v}_Linux_arm64.rpm` },

    // Linux Tarball (for Arch Linux / AUR)
    { pattern: /^fluux-messenger-[\d.]+-linux-x86_64\.tar\.gz$/, newName: `Fluux-Messenger_${v}_Linux_x64.tar.gz` },
    { pattern: /^fluux-messenger-[\d.]+-linux-aarch64\.tar\.gz$/, newName: `Fluux-Messenger_${v}_Linux_arm64.tar.gz` },

    // Linux Flatpak
    { pattern: /^fluux-messenger-[\d.]+-linux-x86_64\.flatpak$/, newName: `Fluux-Messenger_${v}_Linux_x64.flatpak` },
    { pattern: /^fluux-messenger-[\d.]+-linux-aarch64\.flatpak$/, newName: `Fluux-Messenger_${v}_Linux_arm64.flatpak` },
  ];

  for (const { pattern, newName } of mappings) {
    if (pattern.test(oldName)) {
      return newName;
    }
  }

  return null; // No rename needed (e.g., latest.json, source archives)
}

function makeRequest(method, path, data = null) {
  return new Promise((resolve, reject) => {
    const options = {
      hostname: 'api.github.com',
      path,
      method,
      headers: {
        'User-Agent': 'fluux-release-script',
        'Authorization': `Bearer ${process.env.GITHUB_TOKEN}`,
        'Accept': 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
      },
    };

    if (data) {
      options.headers['Content-Type'] = 'application/json';
    }

    const req = https.request(options, (res) => {
      let body = '';
      res.on('data', chunk => body += chunk);
      res.on('end', () => {
        if (res.statusCode >= 200 && res.statusCode < 300) {
          resolve(body ? JSON.parse(body) : null);
        } else {
          reject(new Error(`HTTP ${res.statusCode}: ${body}`));
        }
      });
    });

    req.on('error', reject);

    if (data) {
      req.write(JSON.stringify(data));
    }
    req.end();
  });
}

async function downloadAsset(url) {
  return new Promise((resolve, reject) => {
    const options = {
      headers: {
        'User-Agent': 'fluux-release-script',
        'Authorization': `Bearer ${process.env.GITHUB_TOKEN}`,
        'Accept': 'application/octet-stream',
      },
    };

    https.get(url, options, (res) => {
      if (res.statusCode === 302 || res.statusCode === 301) {
        // Follow redirect
        https.get(res.headers.location, (res2) => {
          let data = '';
          res2.on('data', chunk => data += chunk);
          res2.on('end', () => resolve(data));
        }).on('error', reject);
      } else {
        let data = '';
        res.on('data', chunk => data += chunk);
        res.on('end', () => resolve(data));
      }
    }).on('error', reject);
  });
}

async function main() {
  const args = process.argv.slice(2);
  const tag = args.find(a => !a.startsWith('--'));
  const skipUpdater = args.includes('--skip-updater');

  if (!tag) {
    console.error('Usage: node rename-release-assets.js <tag> [--skip-updater]');
    process.exit(1);
  }

  if (!process.env.GITHUB_TOKEN) {
    console.error('Error: GITHUB_TOKEN environment variable required');
    process.exit(1);
  }

  const version = tag.replace(/^v/, '');
  console.log(`Processing release ${tag} (version ${version})...`);

  // Get release by tag
  const release = await makeRequest('GET', `/repos/${OWNER}/${REPO}/releases/tags/${tag}`);
  console.log(`Found release: ${release.name} with ${release.assets.length} assets`);

  // Build rename map and track URL changes for latest.json
  const urlMap = {}; // oldUrl -> newUrl
  const renames = [];

  for (const asset of release.assets) {
    const newName = getNewName(asset.name, version);
    if (newName && newName !== asset.name) {
      renames.push({ asset, newName });
      const oldUrl = asset.browser_download_url;
      const newUrl = oldUrl.replace(asset.name, newName);
      urlMap[oldUrl] = newUrl;
      console.log(`  ${asset.name} -> ${newName}`);
    }
  }

  if (renames.length === 0) {
    console.log('No assets need renaming.');
    return;
  }

  // Rename assets via GitHub API
  console.log('\nRenaming assets...');
  for (const { asset, newName } of renames) {
    await makeRequest('PATCH', `/repos/${OWNER}/${REPO}/releases/assets/${asset.id}`, {
      name: newName,
    });
    console.log(`  Renamed: ${asset.name} -> ${newName}`);
  }

  // Generate complete latest.json from scratch using .sig files
  // This ensures all platforms are included regardless of which build finished first
  // Skipped for prereleases to prevent Tauri autoupdater from proposing beta versions
  if (skipUpdater) {
    console.log('\nSkipping latest.json generation (prerelease)');
    console.log('\nDone! Assets renamed successfully.');
    return;
  }

  console.log('\nGenerating latest.json...');

  // Re-fetch release to get renamed assets
  const updatedRelease = await makeRequest('GET', `/repos/${OWNER}/${REPO}/releases/tags/${tag}`);

  // Platform mapping: signature file pattern -> { platforms, updater file pattern }
  const platformMappings = [
    {
      sigPattern: /_macOS_arm64\.app\.tar\.gz\.sig$/,
      platforms: ['darwin-aarch64'],
      getUpdaterFile: (v) => `Fluux-Messenger_${v}_macOS_arm64.app.tar.gz`,
    },
    {
      sigPattern: /_macOS_x64\.app\.tar\.gz\.sig$/,
      platforms: ['darwin-x86_64'],
      getUpdaterFile: (v) => `Fluux-Messenger_${v}_macOS_x64.app.tar.gz`,
    },
    {
      sigPattern: /_Windows_x64\.msi\.sig$/,
      platforms: ['windows-x86_64', 'windows-x86_64-msi'],
      getUpdaterFile: (v) => `Fluux-Messenger_${v}_Windows_x64.msi`,
    },
    {
      sigPattern: /_Windows_x64-setup\.exe\.sig$/,
      platforms: ['windows-x86_64-nsis'],
      getUpdaterFile: (v) => `Fluux-Messenger_${v}_Windows_x64-setup.exe`,
    },
  ];

  const platforms = {};
  const baseUrl = `https://github.com/${OWNER}/${REPO}/releases/download/${tag}`;

  for (const mapping of platformMappings) {
    const sigAsset = updatedRelease.assets.find(a => mapping.sigPattern.test(a.name));
    if (sigAsset) {
      console.log(`  Found signature: ${sigAsset.name}`);
      const signature = await downloadAsset(sigAsset.url);
      const updaterFile = mapping.getUpdaterFile(version);

      for (const platform of mapping.platforms) {
        platforms[platform] = {
          signature: signature.trim(),
          url: `${baseUrl}/${updaterFile}`,
        };
        console.log(`    Added platform: ${platform}`);
      }
    }
  }

  if (Object.keys(platforms).length === 0) {
    console.log('  No updater signatures found, skipping latest.json generation');
  } else {
    const latestJson = {
      version,
      notes: `See the [CHANGELOG](https://github.com/${OWNER}/${REPO}/blob/main/CHANGELOG.md) for details.`,
      pub_date: new Date().toISOString(),
      platforms,
    };

    // Delete existing latest.json if present
    const existingLatestJson = updatedRelease.assets.find(a => a.name === 'latest.json');
    if (existingLatestJson) {
      await makeRequest('DELETE', `/repos/${OWNER}/${REPO}/releases/assets/${existingLatestJson.id}`);
      console.log('  Deleted old latest.json');
    }

    // Upload new latest.json
    const uploadUrl = updatedRelease.upload_url.replace('{?name,label}', '?name=latest.json');
    const jsonContent = JSON.stringify(latestJson, null, 2);
    const uploadOptions = {
      hostname: 'uploads.github.com',
      path: uploadUrl.replace('https://uploads.github.com', ''),
      method: 'POST',
      headers: {
        'User-Agent': 'fluux-release-script',
        'Authorization': `Bearer ${process.env.GITHUB_TOKEN}`,
        'Accept': 'application/vnd.github+json',
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(jsonContent),
        'X-GitHub-Api-Version': '2022-11-28',
      },
    };

    await new Promise((resolve, reject) => {
      const req = https.request(uploadOptions, (res) => {
        let body = '';
        res.on('data', chunk => body += chunk);
        res.on('end', () => {
          if (res.statusCode >= 200 && res.statusCode < 300) {
            resolve();
          } else {
            reject(new Error(`Upload failed: HTTP ${res.statusCode}: ${body}`));
          }
        });
      });
      req.on('error', reject);
      req.write(jsonContent);
      req.end();
    });

    console.log(`  Uploaded latest.json with ${Object.keys(platforms).length} platforms`);
  }

  console.log('\nDone! Assets renamed successfully.');
}

main().catch(err => {
  console.error('Error:', err.message);
  process.exit(1);
});
