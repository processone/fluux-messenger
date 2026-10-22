#![cfg_attr(not(any(target_os = "ios", target_os = "android")), allow(dead_code))]
use base64::{engine::general_purpose::STANDARD, Engine};
use serde::{Deserialize, Serialize};
use std::{
    fs,
    io::{self, Read, Seek, SeekFrom},
    path::{Path, PathBuf},
    time::{Duration, SystemTime},
};

const MAX_FILE: u64 = 20 * 1024 * 1024;
/// On iOS a shared JPEG or HEIF photo may be larger, because Fluux reduces it before sending.
/// The share extension applies the same limits when it imports.
pub const MAX_PHOTO: u64 = 64 * 1024 * 1024;
const PHOTO_TYPES: [&str; 3] = ["image/jpeg", "image/heic", "image/heif"];
/// A photo keeps at most this many reduced copies beside its source.
const PHOTO_ATTEMPTS: u8 = 3;
const CHUNK: usize = 256 * 1024;

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ShareDestination {
    pub account: String,
    pub jid: String,
    #[serde(rename = "type")]
    pub kind: String,
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Entry {
    pub id: String,
    pub text: String,
    pub name: Option<String>,
    pub mime: Option<String>,
    pub size: u64,
    #[serde(default)]
    pub suggested_destination: Option<ShareDestination>,
}

pub struct Inbox {
    root: PathBuf,
    max_photo: u64,
}
fn invalid() -> io::Error {
    io::Error::new(io::ErrorKind::InvalidData, "Invalid share")
}
fn valid_id(id: &str) -> io::Result<()> {
    if id.len() != 36 || !id.bytes().all(|c| c.is_ascii_hexdigit() || c == b'-') {
        return Err(invalid());
    }
    Ok(())
}
fn confined(root: &Path, id: &str) -> io::Result<PathBuf> {
    valid_id(id)?;
    let path = root.join(id);
    if fs::symlink_metadata(&path)?.file_type().is_symlink() {
        return Err(invalid());
    }
    Ok(path)
}
fn is_photo_type(mime: Option<&str>) -> bool {
    mime.is_some_and(|mime| PHOTO_TYPES.contains(&mime))
}
/// Checks the file's own signature: a JPEG, or a still HEIF image rather than a sequence.
fn is_photo_file(path: &Path) -> io::Result<bool> {
    let mut header = [0u8; 12];
    let mut file = fs::File::open(path)?;
    if file.read(&mut header)? < header.len() {
        return Ok(false);
    }
    Ok(header.starts_with(&[0xff, 0xd8, 0xff])
        || (&header[4..8] == b"ftyp"
            && [b"heic", b"heix", b"mif1"]
                .contains(&&[header[8], header[9], header[10], header[11]])))
}
/// Where the reduced copy of one attempt is written, beside the photo's `data` file.
pub fn reduced_path(dir: &Path, attempt: u8) -> io::Result<PathBuf> {
    if attempt >= PHOTO_ATTEMPTS {
        return Err(invalid());
    }
    Ok(dir.join(format!("reduced-{attempt}.jpg")))
}
/// Reads a reduced copy written by the native encoder.
pub fn read_reduced(dir: &Path, attempt: u8) -> io::Result<Vec<u8>> {
    let path = reduced_path(dir, attempt)?;
    let metadata = fs::symlink_metadata(&path)?;
    if !metadata.is_file() || metadata.len() > MAX_PHOTO {
        return Err(invalid());
    }
    fs::read(path)
}
impl Inbox {
    pub fn new(root: PathBuf) -> Self {
        let max_photo = if cfg!(target_os = "ios") {
            MAX_PHOTO
        } else {
            MAX_FILE
        };
        Inbox { root, max_photo }
    }
    fn directory(&self, id: &str) -> io::Result<PathBuf> {
        confined(&self.root, id)
    }
    fn entry(&self, id: &str) -> io::Result<Entry> {
        let dir = self.directory(id)?;
        let manifest = dir.join("entry.json");
        let metadata = fs::symlink_metadata(&manifest)?;
        if !metadata.is_file() || metadata.len() > 256 * 1024 {
            return Err(invalid());
        }
        let entry: Entry = serde_json::from_slice(&fs::read(manifest)?).map_err(|_| invalid())?;
        if entry.id != id
            || entry.size > self.max_photo.max(MAX_FILE)
            || entry.text.len() > 64 * 1024
        {
            return Err(invalid());
        }
        if let Some(destination) = &entry.suggested_destination {
            let valid_jid = |value: &str| {
                value.len() <= 3071
                    && !value.contains('/')
                    && !value.chars().any(char::is_whitespace)
                    && value.split('@').count() == 2
                    && value.split('@').all(|part| !part.is_empty())
            };
            if !valid_jid(&destination.account)
                || !valid_jid(&destination.jid)
                || !matches!(destination.kind.as_str(), "chat" | "groupchat")
            {
                return Err(invalid());
            }
        }
        if entry.name.is_some() {
            let file = fs::symlink_metadata(dir.join("data"))?;
            if !file.is_file() || file.len() != entry.size {
                return Err(invalid());
            }
            if entry.size > MAX_FILE
                && !(is_photo_type(entry.mime.as_deref()) && is_photo_file(&dir.join("data"))?)
            {
                return Err(invalid());
            }
        } else if entry.text.is_empty() || entry.size != 0 {
            return Err(invalid());
        }
        Ok(entry)
    }
    pub fn list(&self) -> io::Result<Vec<Entry>> {
        if !self.root.exists() {
            return Ok(vec![]);
        }
        let mut entries = vec![];
        for dir in fs::read_dir(&self.root)? {
            let dir = dir?;
            if let Some(id) = dir.file_name().to_str() {
                // Incomplete writes are hidden until the importer atomically renames its directory.
                if let Ok(entry) = self.entry(id) {
                    entries.push(entry);
                }
            }
        }
        entries.sort_by(|a, b| a.id.cmp(&b.id));
        Ok(entries)
    }
    pub fn read(&self, id: &str, offset: u64) -> io::Result<String> {
        let entry = self.entry(id)?;
        if entry.name.is_none() || offset > entry.size {
            return Err(invalid());
        }
        let mut file = fs::File::open(self.directory(id)?.join("data"))?;
        file.seek(SeekFrom::Start(offset))?;
        let mut bytes = Vec::new();
        file.take(CHUNK as u64).read_to_end(&mut bytes)?;
        Ok(STANDARD.encode(bytes))
    }
    pub fn remove(&self, id: &str) -> io::Result<()> {
        match self.directory(id) {
            Ok(dir) => fs::remove_dir_all(dir),
            Err(e) if e.kind() == io::ErrorKind::NotFound => Ok(()),
            Err(e) => Err(e),
        }
    }
    /// The directory of an imported photo; its reduced copies go away with the import.
    pub fn photo(&self, id: &str) -> io::Result<PathBuf> {
        let entry = self.entry(id)?;
        if entry.name.is_none() || !is_photo_type(entry.mime.as_deref()) {
            return Err(invalid());
        }
        self.directory(id)
    }
}

/// Photos picked or pasted in the app, copied here so they can be decoded natively.
///
/// Each one is a directory named by the app's id, holding `data` and its reduced copies.
pub struct Staging(pub PathBuf);
impl Staging {
    pub fn create(&self, id: &str, bytes: &[u8]) -> io::Result<()> {
        valid_id(id)?;
        if bytes.len() as u64 > MAX_PHOTO {
            return Err(invalid());
        }
        fs::create_dir_all(&self.0)?;
        // A photo whose conversation closed without cleanup, for example when the app was stopped.
        for dir in fs::read_dir(&self.0)?.flatten() {
            let stale = dir
                .metadata()
                .and_then(|m| m.modified())
                .is_ok_and(|modified| {
                    SystemTime::now()
                        .duration_since(modified)
                        .unwrap_or_default()
                        > Duration::from_secs(86400)
                });
            if stale {
                let _ = fs::remove_dir_all(dir.path());
            }
        }
        let dir = self.0.join(id);
        fs::create_dir(&dir)?;
        fs::write(dir.join("data"), bytes)
    }
    pub fn photo(&self, id: &str) -> io::Result<PathBuf> {
        let dir = confined(&self.0, id)?;
        if !fs::symlink_metadata(dir.join("data"))?.is_file() {
            return Err(invalid());
        }
        Ok(dir)
    }
    pub fn remove(&self, id: &str) -> io::Result<()> {
        match confined(&self.0, id) {
            Ok(dir) => fs::remove_dir_all(dir),
            Err(e) if e.kind() == io::ErrorKind::NotFound => Ok(()),
            Err(e) => Err(e),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn durable_reads_are_non_destructive_and_confined() {
        let root = std::env::temp_dir().join(format!(
            "share-inbox-{}",
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        let inbox = Inbox::new(root.clone());
        let id = "12345678-1234-1234-1234-123456789abc";
        let dir = root.join(id);
        fs::create_dir_all(&dir).unwrap();
        let entry = Entry {
            id: id.into(),
            text: "caption".into(),
            name: Some("../photo.png".into()),
            mime: Some("image/png".into()),
            size: 3,
            suggested_destination: None,
        };
        fs::write(dir.join("data"), b"abc").unwrap();
        fs::write(dir.join("entry.json"), serde_json::to_vec(&entry).unwrap()).unwrap();
        assert_eq!(inbox.list().unwrap().len(), 1);
        let mut suggested = entry;
        suggested.suggested_destination = Some(ShareDestination {
            account: "me@example.com".into(),
            jid: "friend@example.com".into(),
            kind: "chat".into(),
        });
        fs::write(
            dir.join("entry.json"),
            serde_json::to_vec(&suggested).unwrap(),
        )
        .unwrap();
        assert_eq!(
            inbox.list().unwrap()[0]
                .suggested_destination
                .as_ref()
                .unwrap()
                .account,
            "me@example.com"
        );
        suggested.suggested_destination.as_mut().unwrap().account = "me@example.com/phone".into();
        fs::write(
            dir.join("entry.json"),
            serde_json::to_vec(&suggested).unwrap(),
        )
        .unwrap();
        assert!(inbox.list().unwrap().is_empty());
        suggested.suggested_destination = None;
        fs::write(
            dir.join("entry.json"),
            serde_json::to_vec(&suggested).unwrap(),
        )
        .unwrap();
        assert_eq!(inbox.read(id, 1).unwrap(), "YmM=");
        assert_eq!(inbox.list().unwrap().len(), 1);
        assert!(inbox.read("../data", 0).is_err());
        assert!(inbox.read(id, 4).is_err());
        assert!(inbox.remove("../data").is_err());
        fs::write(dir.join("data"), b"truncated").unwrap();
        assert!(inbox.list().unwrap().is_empty());
        inbox.remove(id).unwrap();
        inbox.remove(id).unwrap();
        fs::remove_dir_all(root).unwrap();
    }

    fn scratch(name: &str) -> PathBuf {
        std::env::temp_dir().join(format!(
            "{name}-{}",
            SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ))
    }

    // Signatures read from real photos: an iPhone 14 Pro JPEG, its HEIC encoding, and a PNG screenshot.
    const JPEG: &[u8] = &[
        0xff, 0xd8, 0xff, 0xe0, 0x00, 0x14, b'J', b'F', b'I', b'F', 0x00, 0x01,
    ];
    const HEIC: &[u8] = &[
        0x00, 0x00, 0x00, 0x20, b'f', b't', b'y', b'p', b'h', b'e', b'i', b'c',
    ];
    const PNG: &[u8] = &[
        0x89, b'P', b'N', b'G', 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d,
    ];

    fn import(root: &Path, id: &str, mime: &str, header: &[u8], size: u64) {
        let dir = root.join(id);
        fs::create_dir_all(&dir).unwrap();
        let data = fs::File::create(dir.join("data")).unwrap();
        std::io::Write::write_all(&mut &data, header).unwrap();
        data.set_len(size).unwrap();
        let entry = Entry {
            id: id.into(),
            text: String::new(),
            name: Some("photo".into()),
            mime: Some(mime.into()),
            size,
            suggested_destination: None,
        };
        fs::write(dir.join("entry.json"), serde_json::to_vec(&entry).unwrap()).unwrap();
    }

    // Intent: the captain's accepted plan (FLM-22, iOS first) admits shared photos up to 64 MiB
    // so they can be reduced, while other files and other platforms keep 20 MiB.
    #[test]
    fn large_photo_imports_are_accepted_only_on_ios_and_only_for_real_photos() {
        let root = scratch("share-inbox-photos");
        let ios = Inbox {
            root: root.clone(),
            max_photo: MAX_PHOTO,
        };
        let elsewhere = Inbox {
            root: root.clone(),
            max_photo: MAX_FILE,
        };
        let ids = |n: u8| format!("12345678-1234-1234-1234-1234567890{n:02x}");
        let large = 62 * 1024 * 1024;
        import(&root, &ids(1), "image/jpeg", JPEG, large);
        import(&root, &ids(2), "image/heic", HEIC, large);
        import(&root, &ids(3), "image/jpeg", PNG, large);
        import(&root, &ids(4), "application/pdf", JPEG, large);
        import(&root, &ids(5), "image/jpeg", JPEG, MAX_PHOTO + 1);
        import(&root, &ids(6), "image/png", PNG, MAX_FILE);
        let listed = |inbox: &Inbox| {
            inbox
                .list()
                .unwrap()
                .into_iter()
                .map(|e| e.id)
                .collect::<Vec<_>>()
        };
        assert_eq!(listed(&ios), vec![ids(1), ids(2), ids(6)]);
        assert_eq!(listed(&elsewhere), vec![ids(6)]);
        assert!(ios.photo(&ids(1)).is_ok());
        assert!(ios.photo(&ids(6)).is_err(), "a PNG is never reduced");
        assert!(elsewhere.photo(&ids(1)).is_err());
        fs::remove_dir_all(root).unwrap();
    }

    // Intent: FLM-22 keeps reduced copies confined beside their source and removed with it.
    #[test]
    fn staged_photos_and_their_copies_are_confined_and_removed_together() {
        let root = scratch("photo-staging");
        let staging = Staging(root.clone());
        let id = "12345678-1234-1234-1234-123456789abc";
        assert!(staging.create("../escape", JPEG).is_err());
        staging.create(id, JPEG).unwrap();
        assert!(staging.create(id, JPEG).is_err(), "an id is staged once");
        let dir = staging.photo(id).unwrap();
        assert_eq!(fs::read(dir.join("data")).unwrap(), JPEG);
        fs::write(reduced_path(&dir, 2).unwrap(), b"copy").unwrap();
        assert_eq!(read_reduced(&dir, 2).unwrap(), b"copy");
        assert!(reduced_path(&dir, 3).is_err());
        assert!(read_reduced(&dir, 0).is_err());
        assert!(staging.photo("../photo-staging").is_err());
        staging.remove(id).unwrap();
        assert!(!dir.exists());
        staging.remove(id).unwrap();
        fs::remove_dir_all(root).unwrap();
    }
}
