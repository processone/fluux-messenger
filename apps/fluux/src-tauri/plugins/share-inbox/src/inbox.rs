#![cfg_attr(not(any(target_os = "ios", target_os = "android")), allow(dead_code))]
use base64::{engine::general_purpose::STANDARD, Engine};
use serde::{Deserialize, Serialize};
use std::{
    fs,
    io::{self, Read, Seek, SeekFrom},
    path::PathBuf,
};

const MAX_FILE: u64 = 20 * 1024 * 1024;
const CHUNK: usize = 256 * 1024;

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Entry {
    pub id: String,
    pub text: String,
    pub name: Option<String>,
    pub mime: Option<String>,
    pub size: u64,
}

pub struct Inbox(pub PathBuf);
fn invalid() -> io::Error {
    io::Error::new(io::ErrorKind::InvalidData, "Invalid share")
}
impl Inbox {
    fn directory(&self, id: &str) -> io::Result<PathBuf> {
        if id.len() != 36 || !id.bytes().all(|c| c.is_ascii_hexdigit() || c == b'-') {
            return Err(invalid());
        }
        let path = self.0.join(id);
        if fs::symlink_metadata(&path)?.file_type().is_symlink() {
            return Err(invalid());
        }
        Ok(path)
    }
    fn entry(&self, id: &str) -> io::Result<Entry> {
        let dir = self.directory(id)?;
        let manifest = dir.join("entry.json");
        let metadata = fs::symlink_metadata(&manifest)?;
        if !metadata.is_file() || metadata.len() > 256 * 1024 {
            return Err(invalid());
        }
        let entry: Entry = serde_json::from_slice(&fs::read(manifest)?).map_err(|_| invalid())?;
        if entry.id != id || entry.size > MAX_FILE || entry.text.len() > 64 * 1024 {
            return Err(invalid());
        }
        if entry.name.is_some() {
            let file = fs::symlink_metadata(dir.join("data"))?;
            if !file.is_file() || file.len() != entry.size {
                return Err(invalid());
            }
        } else if entry.text.is_empty() || entry.size != 0 {
            return Err(invalid());
        }
        Ok(entry)
    }
    pub fn list(&self) -> io::Result<Vec<Entry>> {
        if !self.0.exists() {
            return Ok(vec![]);
        }
        let mut entries = vec![];
        for dir in fs::read_dir(&self.0)? {
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
        let inbox = Inbox(root.clone());
        let id = "12345678-1234-1234-1234-123456789abc";
        let dir = root.join(id);
        fs::create_dir_all(&dir).unwrap();
        let entry = Entry {
            id: id.into(),
            text: "caption".into(),
            name: Some("../photo.png".into()),
            mime: Some("image/png".into()),
            size: 3,
        };
        fs::write(dir.join("data"), b"abc").unwrap();
        fs::write(dir.join("entry.json"), serde_json::to_vec(&entry).unwrap()).unwrap();
        assert_eq!(inbox.list().unwrap().len(), 1);
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
}
