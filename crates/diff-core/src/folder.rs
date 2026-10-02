//! Reading folders from disk for folder compare (desktop only; the browser reads folders itself).
//!
//! Matching the two trees and deciding each entry's status happens in the UI, which has to
//! do it for both hosts anyway; this module only lists folders and compares file contents.

use std::fs::{self, File};
use std::io::{self, Read};
use std::path::Path;
use std::time::UNIX_EPOCH;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
#[cfg_attr(feature = "serde", derive(serde::Serialize))]
#[cfg_attr(feature = "serde", serde(rename_all = "camelCase"))]
pub enum EntryKind {
    File,
    Dir,
}

/// One file or folder. `modified` is milliseconds since the Unix epoch, when known.
#[derive(Debug, Clone, PartialEq)]
#[cfg_attr(feature = "serde", derive(serde::Serialize))]
#[cfg_attr(feature = "serde", serde(rename_all = "camelCase"))]
pub struct FsEntry {
    pub name: String,
    pub kind: EntryKind,
    pub size: u64,
    pub modified: Option<f64>,
    /// Folder contents, sorted by name; empty for files.
    pub children: Vec<FsEntry>,
}

/// Lists `root` recursively, skipping entries whose name matches one of `exclude`
/// (`*` and `?` wildcards, ignoring case). Symbolic links are listed, not followed,
/// so link cycles can't loop. Entries that can't be read are skipped.
pub fn scan_dir(root: &Path, exclude: &[String]) -> io::Result<Vec<FsEntry>> {
    let mut entries = Vec::new();
    for item in fs::read_dir(root)? {
        let Ok(item) = item else { continue };
        let name = item.file_name().to_string_lossy().into_owned();
        if exclude.iter().any(|p| glob_match(p, &name)) {
            continue;
        }
        let Ok(meta) = item.path().symlink_metadata() else {
            continue;
        };
        let modified = meta
            .modified()
            .ok()
            .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
            .map(|d| d.as_millis() as f64);
        let entry = if meta.is_dir() {
            FsEntry {
                name,
                kind: EntryKind::Dir,
                size: 0,
                modified,
                children: scan_dir(&item.path(), exclude).unwrap_or_default(),
            }
        } else {
            FsEntry {
                name,
                kind: EntryKind::File,
                size: meta.len(),
                modified,
                children: Vec::new(),
            }
        };
        entries.push(entry);
    }
    entries.sort_by(|a, b| a.name.cmp(&b.name));
    Ok(entries)
}

/// Whether two files have the same bytes. Reads both in step and stops at the first difference.
pub fn files_equal(left: &Path, right: &Path) -> io::Result<bool> {
    if fs::metadata(left)?.len() != fs::metadata(right)?.len() {
        return Ok(false);
    }
    let (mut a, mut b) = (File::open(left)?, File::open(right)?);
    let (mut buf_a, mut buf_b) = (vec![0u8; 64 * 1024], vec![0u8; 64 * 1024]);
    loop {
        let n = read_full(&mut a, &mut buf_a)?;
        let m = read_full(&mut b, &mut buf_b)?;
        if n != m || buf_a[..n] != buf_b[..m] {
            return Ok(false);
        }
        if n == 0 {
            return Ok(true);
        }
    }
}

/// Copies a file or a whole folder from `src` to `dst`, creating missing parent folders and
/// overwriting files already there; files in `dst` that `src` lacks are kept. Modified times are
/// copied too, so a size-and-time comparison sees the copies as equal. Symbolic links to folders
/// are not followed, matching [`scan_dir`]. Returns the number of files copied.
pub fn copy_entry(src: &Path, dst: &Path) -> io::Result<u64> {
    let meta = src.symlink_metadata()?;
    if meta.is_dir() && dst.starts_with(src) {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "cannot copy a folder into itself",
        ));
    }
    copy_inner(src, dst, &meta)
}

fn copy_inner(src: &Path, dst: &Path, meta: &fs::Metadata) -> io::Result<u64> {
    if meta.is_dir() {
        fs::create_dir_all(dst)?;
        let mut copied = 0;
        for item in fs::read_dir(src)? {
            let item = item?;
            let path = item.path();
            copied += copy_inner(
                &path,
                &dst.join(item.file_name()),
                &path.symlink_metadata()?,
            )?;
        }
        return Ok(copied);
    }
    if let Some(parent) = dst.parent() {
        fs::create_dir_all(parent)?;
    }
    fs::copy(src, dst)?;
    if let Ok(time) = meta.modified() {
        File::options().write(true).open(dst)?.set_modified(time)?;
    }
    Ok(1)
}

/// Fills `buf` unless the file ends first; returns the byte count.
fn read_full(file: &mut File, buf: &mut [u8]) -> io::Result<usize> {
    let mut filled = 0;
    while filled < buf.len() {
        match file.read(&mut buf[filled..]) {
            Ok(0) => break,
            Ok(n) => filled += n,
            Err(e) if e.kind() == io::ErrorKind::Interrupted => {}
            Err(e) => return Err(e),
        }
    }
    Ok(filled)
}

/// `*` matches any run of characters and `?` one character; letters ignore case.
pub fn glob_match(pattern: &str, name: &str) -> bool {
    let lower = |s: &str| -> Vec<char> {
        s.chars()
            .map(|c| c.to_lowercase().next().unwrap_or(c))
            .collect()
    };
    let (p, n) = (lower(pattern), lower(name));
    let (mut pi, mut ni) = (0, 0);
    let mut star: Option<(usize, usize)> = None;
    while ni < n.len() {
        if pi < p.len() && (p[pi] == '?' || p[pi] == n[ni]) {
            pi += 1;
            ni += 1;
        } else if pi < p.len() && p[pi] == '*' {
            star = Some((pi, ni));
            pi += 1;
        } else if let Some((sp, sn)) = star {
            pi = sp + 1;
            ni = sn + 1;
            star = Some((sp, sn + 1));
        } else {
            return false;
        }
    }
    p[pi..].iter().all(|&c| c == '*')
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn globs() {
        assert!(glob_match(".git", ".git"));
        assert!(glob_match("node_modules", "Node_Modules"));
        assert!(glob_match("*.log", "build.log"));
        assert!(glob_match("*.log", ".log"));
        assert!(!glob_match("*.log", "build.logs"));
        assert!(glob_match("a?c", "abc"));
        assert!(!glob_match("a?c", "ac"));
        assert!(glob_match("*", "anything"));
        assert!(glob_match("*a*b", "xxaxxb"));
        assert!(!glob_match("*a*b", "xxbxxa"));
    }

    #[test]
    fn scans_and_compares() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        fs::create_dir_all(root.join("src/deep")).unwrap();
        fs::create_dir_all(root.join(".git")).unwrap();
        fs::write(root.join("b.txt"), "hello").unwrap();
        fs::write(root.join("a.log"), "x").unwrap();
        fs::write(root.join("src/deep/c.bin"), [0u8, 255]).unwrap();
        fs::write(root.join(".git/HEAD"), "ref").unwrap();

        let entries = scan_dir(root, &[".git".into(), "*.log".into()]).unwrap();
        let names: Vec<_> = entries.iter().map(|e| e.name.as_str()).collect();
        assert_eq!(names, ["b.txt", "src"]);
        assert_eq!(entries[0].kind, EntryKind::File);
        assert_eq!(entries[0].size, 5);
        assert!(entries[0].modified.is_some());
        let deep = &entries[1].children[0];
        assert_eq!((deep.name.as_str(), deep.kind), ("deep", EntryKind::Dir));
        assert_eq!(deep.children[0].size, 2);

        fs::write(root.join("same.txt"), "hello").unwrap();
        fs::write(root.join("other.txt"), "hellp").unwrap();
        assert!(files_equal(&root.join("b.txt"), &root.join("same.txt")).unwrap());
        assert!(!files_equal(&root.join("b.txt"), &root.join("other.txt")).unwrap());
        assert!(!files_equal(&root.join("b.txt"), &root.join("a.log")).unwrap());
    }

    #[test]
    fn copies_files_and_folders() {
        let dir = tempfile::tempdir().unwrap();
        let (src, dst) = (dir.path().join("src"), dir.path().join("dst"));
        fs::create_dir_all(src.join("a/b")).unwrap();
        fs::create_dir_all(dst.join("a")).unwrap();
        fs::write(src.join("a/b/new.txt"), "new").unwrap();
        fs::write(src.join("a/same.txt"), "from src").unwrap();
        fs::write(dst.join("a/same.txt"), "old").unwrap();
        fs::write(dst.join("a/keep.txt"), "keep").unwrap();

        assert_eq!(copy_entry(&src.join("a"), &dst.join("a")).unwrap(), 2);
        assert_eq!(fs::read_to_string(dst.join("a/b/new.txt")).unwrap(), "new");
        assert_eq!(
            fs::read_to_string(dst.join("a/same.txt")).unwrap(),
            "from src"
        );
        assert_eq!(fs::read_to_string(dst.join("a/keep.txt")).unwrap(), "keep");
        let time = |p: &Path| fs::metadata(p).unwrap().modified().unwrap();
        assert_eq!(time(&src.join("a/same.txt")), time(&dst.join("a/same.txt")));

        // A single file into a folder that doesn't exist yet.
        assert_eq!(
            copy_entry(&src.join("a/b/new.txt"), &dst.join("x/y/new.txt")).unwrap(),
            1
        );
        assert!(files_equal(&src.join("a/b/new.txt"), &dst.join("x/y/new.txt")).unwrap());
        assert!(copy_entry(&src, &src.join("a/inner")).is_err());
    }

    #[test]
    fn compares_large_files() {
        let dir = tempfile::tempdir().unwrap();
        let data: Vec<u8> = (0..200_000u32).map(|i| (i % 251) as u8).collect();
        let mut changed = data.clone();
        changed[150_000] ^= 1;
        fs::write(dir.path().join("a"), &data).unwrap();
        fs::write(dir.path().join("b"), &data).unwrap();
        fs::write(dir.path().join("c"), &changed).unwrap();
        assert!(files_equal(&dir.path().join("a"), &dir.path().join("b")).unwrap());
        assert!(!files_equal(&dir.path().join("a"), &dir.path().join("c")).unwrap());
    }
}
