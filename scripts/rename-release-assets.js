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

    // Linux RPM
    { pattern: /^Fluux\.Messenger-[\d.]+-\d+\.x86_64\.rpm$/, newName: `Fluux-Messenger_${v}_Linux_x64.rpm` },
    { pattern: /^Fluux\.Messenger-[\d.]+-\d+\.x86_64\.rpm\.sig$/, newName: `Fluux-Messenger_${v}_Linux_x64.rpm.sig` },
    { pattern: /^Fluux\.Messenger-[\d.]+-\d+\.aarch64\.rpm$/, newName: `Fluux-Messenger_${v}_Linux_arm64.rpm` },
    { pattern: /^Fluux\.Messenger-[\d.]+-\d+\.aarch64\.rpm\.sig$/, newName: `Fluux-Messenger_${v}_Linux_arm64.rpm.sig` },
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
  const tag = process.argv[2];
  if (!tag) {
    console.error('Usage: node rename-release-assets.js <tag>');
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

  // Download and update latest.json
  console.log('\nUpdating latest.json...');
  const latestJsonAsset = release.assets.find(a => a.name === 'latest.json');
  if (latestJsonAsset) {
    const latestJsonContent = await downloadAsset(latestJsonAsset.url);
    const latestJson = JSON.parse(latestJsonContent);

    // Update all URLs in the platforms
    for (const [platform, data] of Object.entries(latestJson.platforms)) {
      if (urlMap[data.url]) {
        console.log(`  Updating ${platform}: ${data.url} -> ${urlMap[data.url]}`);
        latestJson.platforms[platform].url = urlMap[data.url];
      }
    }

    // Delete old latest.json and upload new one
    await makeRequest('DELETE', `/repos/${OWNER}/${REPO}/releases/assets/${latestJsonAsset.id}`);

    // Upload updated latest.json
    const uploadUrl = release.upload_url.replace('{?name,label}', `?name=latest.json`);
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

    console.log('  Uploaded updated latest.json');
  }

  console.log('\nDone! Assets renamed successfully.');
}

main().catch(err => {
  console.error('Error:', err.message);
  process.exit(1);
});
