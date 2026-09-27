//! SMB2 file operations and the information classes clients query.
//!
//! Most of the bulk here is marshalling: Windows asks for file and filesystem
//! metadata through a couple of dozen numbered "information classes", each with
//! its own fixed layout. Answering the common ones correctly is the difference
//! between a share that mounts and one that appears empty or read-only.

use crate::storage::meta::{Attr, Kind, SetAttr, Timespec};

use super::server::{status_of, Status, FULL_ACCESS, READ_ACCESS};
use super::session::{Connection, Handle};
use super::wire::*;

// File attributes.
const FILE_ATTRIBUTE_DIRECTORY: u32 = 0x0000_0010;
const FILE_ATTRIBUTE_NORMAL: u32 = 0x0000_0080;
const FILE_ATTRIBUTE_ARCHIVE: u32 = 0x0000_0020;
const FILE_ATTRIBUTE_REPARSE_POINT: u32 = 0x0000_0400;

// Create dispositions.
const FILE_SUPERSEDE: u32 = 0;
const FILE_OPEN: u32 = 1;
const FILE_CREATE: u32 = 2;
const FILE_OPEN_IF: u32 = 3;
const FILE_OVERWRITE: u32 = 4;
const FILE_OVERWRITE_IF: u32 = 5;

// Create options.
const FILE_DIRECTORY_FILE: u32 = 0x0000_0001;
const FILE_NON_DIRECTORY_FILE: u32 = 0x0000_0040;
const FILE_DELETE_ON_CLOSE: u32 = 0x0000_1000;

// Create actions, reported back to the client.
const ACTION_SUPERSEDED: u32 = 0;
const ACTION_OPENED: u32 = 1;
const ACTION_CREATED: u32 = 2;
const ACTION_OVERWRITTEN: u32 = 3;

/// `FILE_ATTRIBUTE_READONLY` — what a client reads to grey out editing.
const FILE_ATTRIBUTE_READONLY: u32 = 0x0000_0001;
/// `FILE_READ_ONLY_VOLUME`, reported in the filesystem attributes.
const FILE_READ_ONLY_VOLUME: u32 = 0x0008_0000;

fn attributes(kind: Kind, writable: bool) -> u32 {
    let base = match kind {
        Kind::Dir => FILE_ATTRIBUTE_DIRECTORY,
        Kind::Symlink => FILE_ATTRIBUTE_REPARSE_POINT | FILE_ATTRIBUTE_ARCHIVE,
        Kind::File => FILE_ATTRIBUTE_ARCHIVE | FILE_ATTRIBUTE_NORMAL,
    };
    if writable {
        base
    } else {
        base | FILE_ATTRIBUTE_READONLY
    }
}

/// Space a file occupies, rounded up to a cluster as clients expect.
fn allocation(size: u64) -> u64 {
    size.div_ceil(4096) * 4096
}

fn write_times(w: &mut Writer, a: &Attr) {
    w.u64(filetime(a.ctime.secs, a.ctime.nanos)); // creation
    w.u64(filetime(a.atime.secs, a.atime.nanos));
    w.u64(filetime(a.mtime.secs, a.mtime.nanos));
    w.u64(filetime(a.ctime.secs, a.ctime.nanos)); // change
}

/// Read a 16-byte SMB2 file id, resolving the all-ones form that a compounded
/// "related" request uses to mean "the handle the previous request produced".
fn read_file_id(r: &mut Reader, last_handle: u64) -> u64 {
    let persistent = r.u64();
    r.u64(); // volatile half; this server keeps them identical
    if persistent == u64::MAX {
        last_handle
    } else {
        persistent
    }
}

fn write_file_id(w: &mut Writer, id: u64) {
    w.u64(id);
    w.u64(id);
}

// ---- CREATE / CLOSE ----

pub async fn create(
    conn: &mut Connection,
    header: &Header,
    request: &[u8],
    last_handle: &mut u64,
) -> Status<Vec<u8>> {
    let mut r = Reader::at(request, HEADER_LEN);
    r.skip(2 + 1 + 1 + 4 + 8 + 8); // structure size, flags, oplock, impersonation, reserved
    let _desired_access = r.u32();
    let _file_attributes = r.u32();
    let _share_access = r.u32();
    let disposition = r.u32();
    let options = r.u32();
    let name_offset = r.u16() as usize;
    let name_len = r.u16() as usize;
    let path = utf16_to_string(r.view(name_offset, name_len));

    tracing::debug!("smb: create {path:?} disposition {disposition} options {options:#x}");
    let want_dir = options & FILE_DIRECTORY_FILE != 0;
    let want_file = options & FILE_NON_DIRECTORY_FILE != 0;

    let existing = conn.resolve(&path).await.ok();
    let (ino, action) = match (existing, disposition) {
        (Some(ino), FILE_OPEN | FILE_OPEN_IF) => (ino, ACTION_OPENED),
        (Some(_), FILE_CREATE) => return Err(STATUS_OBJECT_NAME_COLLISION),
        (Some(ino), FILE_OVERWRITE | FILE_OVERWRITE_IF | FILE_SUPERSEDE) => {
            // Truncate in place rather than unlink-and-recreate, so the inode
            // number the client may already be holding stays valid.
            conn.volume
                .setattr(ino, SetAttr { size: Some(0), ..Default::default() })
                .await
                .map_err(status_of)?;
            (
                ino,
                if disposition == FILE_SUPERSEDE { ACTION_SUPERSEDED } else { ACTION_OVERWRITTEN },
            )
        }
        (None, FILE_OPEN | FILE_OVERWRITE) => return Err(STATUS_OBJECT_NAME_NOT_FOUND),
        (None, _) => {
            let (parent, name) = conn.resolve_parent(&path).await.map_err(status_of)?;
            let created = if want_dir {
                conn.volume.mkdir(parent, name.as_bytes(), 0o755).await
            } else {
                conn.volume.create(parent, name.as_bytes(), 0o644).await
            };
            (created.map_err(status_of)?.0, ACTION_CREATED)
        }
        (Some(ino), _) => (ino, ACTION_OPENED),
    };

    let attr = conn.volume.getattr(ino).await.map_err(status_of)?;

    // Honour the client's assertion about what kind of object it expects.
    if want_dir && attr.kind != Kind::Dir {
        return Err(STATUS_NOT_A_DIRECTORY);
    }
    if want_file && attr.kind == Kind::Dir {
        return Err(STATUS_FILE_IS_A_DIRECTORY);
    }

    let id = conn.open_handle(Handle {
        ino,
        kind: attr.kind,
        path: path.clone(),
        dir_cursor: None,
        dir_pattern: String::new(),
        dir_index: 0,
        delete_on_close: options & FILE_DELETE_ON_CLOSE != 0,
    });
    *last_handle = id;

    let mut w = Writer::new();
    header.write_response(&mut w, STATUS_SUCCESS, header.credits.max(1));
    w.u16(89);
    w.u8(0); // oplock level: none
    w.u8(0); // flags
    w.u32(action);
    write_times(&mut w, &attr);
    w.u64(allocation(attr.size));
    w.u64(attr.size);
    w.u32(attributes(attr.kind, conn.volume.writable()));
    w.u32(0); // reserved
    write_file_id(&mut w, id);
    w.u32(0); // create contexts offset
    w.u32(0); // create contexts length
    Ok(w.buf)
}

pub async fn close(
    conn: &mut Connection,
    header: &Header,
    request: &[u8],
    last_handle: &mut u64,
) -> Status<Vec<u8>> {
    let mut r = Reader::at(request, HEADER_LEN);
    r.skip(2);
    let flags = r.u16();
    r.skip(4);
    let id = read_file_id(&mut r, *last_handle);

    let writable = conn.volume.writable();
    let Some(handle) = conn.close_handle(id) else {
        return Err(STATUS_INVALID_PARAMETER);
    };
    let attr = conn.volume.getattr(handle.ino).await.ok();

    // SMB expresses "delete this file" as a flag set on an open handle, which
    // only takes effect here.
    if handle.delete_on_close
        && let Ok((parent, name)) = conn.resolve_parent(&handle.path).await
            && let Err(e) = conn.volume.remove(parent, name.as_bytes()).await {
                tracing::debug!("smb: delete-on-close failed for {}: {e}", handle.path);
            }

    let mut w = Writer::new();
    header.write_response(&mut w, STATUS_SUCCESS, header.credits.max(1));
    w.u16(60);
    // Flag bit 1 means the attribute fields below are populated.
    let postquery = flags & 0x0001 != 0 && attr.is_some();
    w.u16(if postquery { 1 } else { 0 });
    w.u32(0);
    match (postquery, attr) {
        (true, Some(a)) => {
            write_times(&mut w, &a);
            w.u64(allocation(a.size));
            w.u64(a.size);
            w.u32(attributes(a.kind, writable));
        }
        _ => {
            w.zeros(32 + 16);
            w.u32(0);
        }
    }
    Ok(w.buf)
}

// ---- READ / WRITE ----

pub async fn read(
    conn: &mut Connection,
    header: &Header,
    request: &[u8],
    last_handle: &mut u64,
) -> Status<Vec<u8>> {
    let mut r = Reader::at(request, HEADER_LEN);
    r.skip(2 + 1 + 1);
    let length = r.u32();
    let offset = r.u64();
    let id = read_file_id(&mut r, *last_handle);

    let Some(handle) = conn.handle(id) else {
        return Err(STATUS_INVALID_PARAMETER);
    };
    if handle.kind == Kind::Dir {
        return Err(STATUS_FILE_IS_A_DIRECTORY);
    }
    let ino = handle.ino;

    let (data, _eof) = conn.volume.read(ino, offset, length).await.map_err(status_of)?;
    // A zero-length read at or past EOF is reported as an error, not an empty
    // success; clients rely on it to detect the end of a file.
    if data.is_empty() {
        return Err(STATUS_END_OF_FILE);
    }

    let mut w = Writer::new();
    header.write_response(&mut w, STATUS_SUCCESS, header.credits.max(1));
    w.u16(17);
    let data_offset = HEADER_LEN + 16;
    w.u8(data_offset as u8);
    w.u8(0);
    w.u32(data.len() as u32);
    w.u32(0); // data remaining
    w.u32(0); // reserved
    debug_assert_eq!(w.len(), data_offset);
    w.bytes(&data);
    Ok(w.buf)
}

pub async fn write(
    conn: &mut Connection,
    header: &Header,
    request: &[u8],
    last_handle: &mut u64,
) -> Status<Vec<u8>> {
    let mut r = Reader::at(request, HEADER_LEN);
    r.skip(2);
    let data_offset = r.u16() as usize;
    let length = r.u32() as usize;
    let offset = r.u64();
    let id = read_file_id(&mut r, *last_handle);

    let Some(handle) = conn.handle(id) else {
        return Err(STATUS_INVALID_PARAMETER);
    };
    if handle.kind == Kind::Dir {
        return Err(STATUS_FILE_IS_A_DIRECTORY);
    }
    let ino = handle.ino;
    let data = r.view(data_offset, length).to_vec();

    conn.volume.write(ino, offset, &data).await.map_err(status_of)?;
    if let Err(e) = conn.volume.maybe_checkpoint().await {
        tracing::error!("smb: checkpoint after write failed: {e}");
    }

    let mut w = Writer::new();
    header.write_response(&mut w, STATUS_SUCCESS, header.credits.max(1));
    w.u16(17);
    w.u16(0); // reserved
    w.u32(data.len() as u32);
    w.u32(0); // remaining
    w.u16(0); // write channel info offset
    w.u16(0); // write channel info length
    Ok(w.buf)
}

// ---- QUERY_DIRECTORY ----

const FILE_DIRECTORY_INFORMATION: u8 = 1;
const FILE_FULL_DIRECTORY_INFORMATION: u8 = 2;
const FILE_BOTH_DIRECTORY_INFORMATION: u8 = 3;
const FILE_NAMES_INFORMATION: u8 = 12;
const FILE_ID_BOTH_DIRECTORY_INFORMATION: u8 = 37;
const FILE_ID_FULL_DIRECTORY_INFORMATION: u8 = 38;

const RESTART_SCANS: u8 = 0x01;

pub async fn query_directory(
    conn: &mut Connection,
    header: &Header,
    request: &[u8],
    last_handle: &mut u64,
) -> Status<Vec<u8>> {
    let mut r = Reader::at(request, HEADER_LEN);
    r.skip(2);
    let info_class = r.u8();
    let flags = r.u8();
    r.skip(4); // file index
    let id = read_file_id(&mut r, *last_handle);
    let pattern_offset = r.u16() as usize;
    let pattern_len = r.u16() as usize;
    let output_len = r.u32() as usize;
    let pattern = utf16_to_string(r.view(pattern_offset, pattern_len));

    let Some(handle) = conn.handle(id) else {
        return Err(STATUS_INVALID_PARAMETER);
    };
    if handle.kind != Kind::Dir {
        return Err(STATUS_NOT_A_DIRECTORY);
    }
    let dir_ino = handle.ino;
    let restart = flags & RESTART_SCANS != 0;
    // A new pattern always starts a new scan: clients reuse one directory
    // handle to look up many different names.
    let pattern_changed = handle.dir_pattern != pattern;
    let needs_listing = restart
        || pattern_changed
        || conn.handle(id).and_then(|h| h.dir_cursor.as_ref()).is_none();

    if needs_listing {
        // `.` and `..` are not part of the engine's namespace but clients
        // expect to see them, so they are synthesised at the front.
        let mut entries = vec![(b".".to_vec(), dir_ino)];
        let parent = conn.volume.parent(dir_ino).await.map_err(status_of)?;
        entries.push((b"..".to_vec(), parent));

        let mut after = 0;
        loop {
            let (page, end) = conn
                .volume
                .readdir(dir_ino, after, 256)
                .await
                .map_err(status_of)?;
            if let Some((_, attr)) = page.last() {
                after = attr.ino;
            }
            entries.extend(page.into_iter().map(|(name, attr)| (name, attr.ino)));
            if end {
                break;
            }
        }

        // Clients issue a single-name pattern as their equivalent of `stat`,
        // so returning an unfiltered listing makes every lookup fail.
        entries.retain(|(name, _)| matches_pattern(&pattern, &String::from_utf8_lossy(name)));

        let handle = conn.handle_mut(id).ok_or(STATUS_INVALID_PARAMETER)?;
        handle.dir_cursor = Some(entries);
        handle.dir_pattern = pattern.clone();
        handle.dir_index = 0;
    }

    let (entries, mut index) = {
        let handle = conn.handle(id).ok_or(STATUS_INVALID_PARAMETER)?;
        (handle.dir_cursor.clone().unwrap_or_default(), handle.dir_index)
    };
    if index >= entries.len() {
        // A pattern that matched nothing at all is "no such file"; running off
        // the end of a listing that did match is "no more files".
        return Err(if entries.is_empty() && !pattern.is_empty() {
            STATUS_NO_SUCH_FILE
        } else {
            STATUS_NO_MORE_FILES
        });
    }

    let mut body = Writer::new();
    let mut last_entry_at: Option<usize> = None;
    while index < entries.len() {
        let (name, ino) = &entries[index];
        let attr = match conn.volume.getattr(*ino).await {
            Ok(a) => a,
            // A concurrent unlink between listing and reporting is not an error.
            Err(_) => {
                index += 1;
                continue;
            }
        };
        let entry = encode_dir_entry(info_class, name, &attr, conn.volume.writable())?;
        if body.len() + entry.len() > output_len {
            break;
        }
        last_entry_at = Some(body.len());
        body.bytes(&entry);
        index += 1;
    }

    let Some(last_at) = last_entry_at else {
        // Not even one entry fits in the buffer the client offered.
        return Err(STATUS_INFO_LENGTH_MISMATCH);
    };
    // The final entry's NextEntryOffset must be zero to terminate the chain.
    body.patch_u32(last_at, 0);

    if let Some(handle) = conn.handle_mut(id) {
        handle.dir_index = index;
    }

    let mut w = Writer::new();
    header.write_response(&mut w, STATUS_SUCCESS, header.credits.max(1));
    w.u16(9);
    let offset_at = w.len();
    w.u16(0);
    w.u32(body.len() as u32);
    let body_at = w.len();
    w.bytes(&body.buf);
    w.patch_u16(offset_at, body_at as u16);
    Ok(w.buf)
}

/// Encode one directory entry. The classes share a prefix and differ in which
/// trailing fields appear before the name.
fn encode_dir_entry(
    info_class: u8,
    name: &[u8],
    attr: &Attr,
    writable: bool,
) -> Status<Vec<u8>> {
    let name_utf16 = string_to_utf16(&String::from_utf8_lossy(name));
    let mut w = Writer::new();

    w.u32(0); // NextEntryOffset, patched by the caller for the last entry
    w.u32(0); // FileIndex; zero means "server does not support resume by index"

    if info_class == FILE_NAMES_INFORMATION {
        w.u32(name_utf16.len() as u32);
        w.bytes(&name_utf16);
        let len = w.len();
        w.patch_u32(0, len.next_multiple_of(8) as u32);
        w.align8();
        return Ok(w.buf);
    }

    write_times(&mut w, attr);
    w.u64(attr.size);
    w.u64(allocation(attr.size));
    w.u32(attributes(attr.kind, writable));
    w.u32(name_utf16.len() as u32);

    match info_class {
        FILE_DIRECTORY_INFORMATION => {}
        FILE_FULL_DIRECTORY_INFORMATION => {
            w.u32(0); // EaSize
        }
        FILE_BOTH_DIRECTORY_INFORMATION => {
            w.u32(0); // EaSize
            w.u8(0); // ShortNameLength: no 8.3 aliases
            w.u8(0); // Reserved
            w.zeros(24); // ShortName
        }
        FILE_ID_FULL_DIRECTORY_INFORMATION => {
            w.u32(0); // EaSize
            w.u32(0); // Reserved
            w.u64(attr.ino);
        }
        FILE_ID_BOTH_DIRECTORY_INFORMATION => {
            w.u32(0); // EaSize
            w.u8(0);
            w.u8(0);
            w.zeros(24);
            w.u16(0); // Reserved2
            w.u64(attr.ino);
        }
        other => {
            tracing::debug!("smb: unsupported directory info class {other}");
            return Err(STATUS_INVALID_INFO_CLASS);
        }
    }

    w.bytes(&name_utf16);
    let len = w.len();
    w.patch_u32(0, len.next_multiple_of(8) as u32);
    w.align8();
    Ok(w.buf)
}

// ---- QUERY_INFO / SET_INFO ----

const INFO_FILE: u8 = 1;
const INFO_FILESYSTEM: u8 = 2;

const FILE_BASIC_INFORMATION: u8 = 4;
const FILE_STANDARD_INFORMATION: u8 = 5;
const FILE_INTERNAL_INFORMATION: u8 = 6;
const FILE_EA_INFORMATION: u8 = 7;
const FILE_ACCESS_INFORMATION: u8 = 8;
const FILE_NAME_INFORMATION: u8 = 9;
const FILE_RENAME_INFORMATION: u8 = 10;
const FILE_DISPOSITION_INFORMATION: u8 = 13;
const FILE_POSITION_INFORMATION: u8 = 14;
const FILE_MODE_INFORMATION: u8 = 16;
const FILE_ALIGNMENT_INFORMATION: u8 = 17;
const FILE_ALL_INFORMATION: u8 = 18;
const FILE_ALLOCATION_INFORMATION: u8 = 19;
const FILE_END_OF_FILE_INFORMATION: u8 = 20;
const FILE_NETWORK_OPEN_INFORMATION: u8 = 34;
const FILE_ATTRIBUTE_TAG_INFORMATION: u8 = 35;

const FS_VOLUME_INFORMATION: u8 = 1;
const FS_SIZE_INFORMATION: u8 = 3;
const FS_DEVICE_INFORMATION: u8 = 4;
const FS_ATTRIBUTE_INFORMATION: u8 = 5;
const FS_FULL_SIZE_INFORMATION: u8 = 7;

/// Reported capacity. The real backing store is an object store with no
/// meaningful size, so a large constant is presented; clients refuse to write
/// to a volume reporting zero free space.
const VOLUME_BYTES: u64 = 1 << 44; // 16 TiB
const CLUSTER_BYTES: u64 = 4096;

pub async fn query_info(
    conn: &mut Connection,
    header: &Header,
    request: &[u8],
    last_handle: &mut u64,
) -> Status<Vec<u8>> {
    let mut r = Reader::at(request, HEADER_LEN);
    r.skip(2);
    let info_type = r.u8();
    let info_class = r.u8();
    let output_len = r.u32() as usize;
    r.skip(2 + 2 + 4 + 4 + 4); // input buffer fields, additional info, flags
    let id = read_file_id(&mut r, *last_handle);

    let body = match info_type {
        INFO_FILE => {
            let Some(handle) = conn.handle(id) else {
                return Err(STATUS_INVALID_PARAMETER);
            };
            let (ino, path) = (handle.ino, handle.path.clone());
            let attr = conn.volume.getattr(ino).await.map_err(status_of)?;
            file_info(info_class, &attr, &path, conn.volume.writable())?
        }
        INFO_FILESYSTEM => fs_info(
            info_class,
            conn.volume.writable(),
            conn.volume.filesystem_id(),
        )?,
        _ => return Err(STATUS_INVALID_INFO_CLASS),
    };

    if body.len() > output_len {
        return Err(STATUS_BUFFER_OVERFLOW);
    }

    let mut w = Writer::new();
    header.write_response(&mut w, STATUS_SUCCESS, header.credits.max(1));
    w.u16(9);
    let offset_at = w.len();
    w.u16(0);
    w.u32(body.len() as u32);
    let body_at = w.len();
    w.bytes(&body);
    w.patch_u16(offset_at, body_at as u16);
    Ok(w.buf)
}

fn file_info(info_class: u8, attr: &Attr, path: &str, writable: bool) -> Status<Vec<u8>> {
    let access = if writable { FULL_ACCESS } else { READ_ACCESS };
    let mut w = Writer::new();
    match info_class {
        FILE_BASIC_INFORMATION => {
            write_times(&mut w, attr);
            w.u32(attributes(attr.kind, writable));
            w.u32(0); // reserved
        }
        FILE_STANDARD_INFORMATION => {
            w.u64(allocation(attr.size));
            w.u64(attr.size);
            w.u32(attr.nlink);
            w.u8(0); // delete pending
            w.u8(u8::from(attr.kind == Kind::Dir));
            w.u16(0); // reserved
        }
        FILE_INTERNAL_INFORMATION => {
            w.u64(attr.ino);
        }
        FILE_EA_INFORMATION => {
            w.u32(0);
        }
        FILE_ACCESS_INFORMATION => {
            w.u32(access);
        }
        FILE_NAME_INFORMATION => {
            let name = string_to_utf16(&normalise(path));
            w.u32(name.len() as u32);
            w.bytes(&name);
        }
        FILE_POSITION_INFORMATION => {
            w.u64(0);
        }
        FILE_MODE_INFORMATION => {
            w.u32(0);
        }
        FILE_ALIGNMENT_INFORMATION => {
            w.u32(0); // byte alignment
        }
        FILE_NETWORK_OPEN_INFORMATION => {
            write_times(&mut w, attr);
            w.u64(allocation(attr.size));
            w.u64(attr.size);
            w.u32(attributes(attr.kind, writable));
            w.u32(0);
        }
        FILE_ATTRIBUTE_TAG_INFORMATION => {
            w.u32(attributes(attr.kind, writable));
            w.u32(0); // reparse tag
        }
        FILE_ALL_INFORMATION => {
            // Basic
            write_times(&mut w, attr);
            w.u32(attributes(attr.kind, writable));
            w.u32(0);
            // Standard
            w.u64(allocation(attr.size));
            w.u64(attr.size);
            w.u32(attr.nlink);
            w.u8(0);
            w.u8(u8::from(attr.kind == Kind::Dir));
            w.u16(0);
            // Internal, EA, access, position, mode, alignment
            w.u64(attr.ino);
            w.u32(0);
            w.u32(access);
            w.u64(0);
            w.u32(0);
            w.u32(0);
            // Name
            let name = string_to_utf16(&normalise(path));
            w.u32(name.len() as u32);
            w.bytes(&name);
        }
        other => {
            tracing::debug!("smb: unsupported file info class {other}");
            return Err(STATUS_INVALID_INFO_CLASS);
        }
    }
    Ok(w.buf)
}

fn fs_info(info_class: u8, writable: bool, filesystem_id: u64) -> Status<Vec<u8>> {
    let mut w = Writer::new();
    match info_class {
        FS_VOLUME_INFORMATION => {
            w.u64(0); // volume creation time
            w.u32(filesystem_id as u32);
            let label = string_to_utf16("lfs");
            w.u32(label.len() as u32);
            w.u8(0); // supports objects
            w.u8(0);
            w.bytes(&label);
        }
        FS_SIZE_INFORMATION => {
            w.u64(VOLUME_BYTES / CLUSTER_BYTES);
            w.u64(VOLUME_BYTES / CLUSTER_BYTES / 2);
            w.u32(1); // sectors per allocation unit
            w.u32(CLUSTER_BYTES as u32);
        }
        FS_FULL_SIZE_INFORMATION => {
            w.u64(VOLUME_BYTES / CLUSTER_BYTES);
            w.u64(VOLUME_BYTES / CLUSTER_BYTES / 2);
            w.u64(VOLUME_BYTES / CLUSTER_BYTES / 2);
            w.u32(1);
            w.u32(CLUSTER_BYTES as u32);
        }
        FS_DEVICE_INFORMATION => {
            w.u32(0x0000_0007); // FILE_DEVICE_DISK
            w.u32(0x0000_0020); // FILE_REMOTE_DEVICE
        }
        FS_ATTRIBUTE_INFORMATION => {
            // Case-sensitive search and preserved case, unicode names. No ACLs,
            // no compression, no named streams: the engine has none of them.
            let mut flags = 0x0000_0003 | 0x0000_0004;
            if !writable {
                flags |= FILE_READ_ONLY_VOLUME;
            }
            w.u32(flags);
            w.u32(255); // maximum component name length
            let name = string_to_utf16("lfs");
            w.u32(name.len() as u32);
            w.bytes(&name);
        }
        other => {
            tracing::debug!("smb: unsupported filesystem info class {other}");
            return Err(STATUS_INVALID_INFO_CLASS);
        }
    }
    Ok(w.buf)
}

pub async fn set_info(
    conn: &mut Connection,
    header: &Header,
    request: &[u8],
    last_handle: &mut u64,
) -> Status<Vec<u8>> {
    let mut r = Reader::at(request, HEADER_LEN);
    r.skip(2);
    let info_type = r.u8();
    let info_class = r.u8();
    let buffer_len = r.u32() as usize;
    let buffer_offset = r.u16() as usize;
    r.skip(2 + 4); // reserved, additional information
    let id = read_file_id(&mut r, *last_handle);
    let buffer = r.view(buffer_offset, buffer_len).to_vec();

    if info_type != INFO_FILE {
        return Err(STATUS_INVALID_INFO_CLASS);
    }
    let Some(handle) = conn.handle(id) else {
        return Err(STATUS_INVALID_PARAMETER);
    };
    let (ino, path) = (handle.ino, handle.path.clone());

    match info_class {
        FILE_BASIC_INFORMATION => {
            let mut b = Reader::new(&buffer);
            let _creation = b.u64();
            let atime = from_filetime(b.u64());
            let mtime = from_filetime(b.u64());
            let _change = b.u64();
            conn.volume
                .setattr(
                    ino,
                    SetAttr {
                        atime: atime.map(|(secs, nanos)| Timespec { secs, nanos }),
                        mtime: mtime.map(|(secs, nanos)| Timespec { secs, nanos }),
                        ..Default::default()
                    },
                )
                .await
                .map_err(status_of)?;
        }

        FILE_END_OF_FILE_INFORMATION | FILE_ALLOCATION_INFORMATION => {
            let mut b = Reader::new(&buffer);
            let size = b.u64();
            // An allocation hint must not shrink the file; only an explicit
            // end-of-file change may truncate.
            if info_class == FILE_END_OF_FILE_INFORMATION {
                conn.volume
                    .setattr(ino, SetAttr { size: Some(size), ..Default::default() })
                    .await
                    .map_err(status_of)?;
            }
        }

        FILE_DISPOSITION_INFORMATION => {
            let delete = buffer.first().copied().unwrap_or(0) != 0;
            // The check has to happen now, not at close: this response is the
            // only chance the client has to see the failure, and `rmdir` on a
            // non-empty directory would otherwise report success.
            if delete {
                let attr = conn.volume.getattr(ino).await.map_err(status_of)?;
                if attr.kind == Kind::Dir {
                    let (entries, _) =
                        conn.volume.readdir(ino, 0, 1).await.map_err(status_of)?;
                    if !entries.is_empty() {
                        return Err(STATUS_DIRECTORY_NOT_EMPTY);
                    }
                }
            }
            if let Some(handle) = conn.handle_mut(id) {
                handle.delete_on_close = delete;
            }
        }

        FILE_RENAME_INFORMATION => {
            let mut b = Reader::new(&buffer);
            let _replace = b.u8();
            b.skip(7);
            b.u64(); // root directory, always zero for a relative rename
            let name_len = b.u32() as usize;
            // ReplaceIfExists(1) + Reserved(7) + RootDirectory(8) + Length(4).
            const NAME_AT: usize = 20;
            let target =
                utf16_to_string(&buffer[NAME_AT.min(buffer.len())..(NAME_AT + name_len).min(buffer.len())]);
            tracing::debug!("smb: rename {path:?} -> {target:?}");

            let (from_parent, from_name) = conn.resolve_parent(&path).await.map_err(status_of)?;
            let (to_parent, to_name) = conn.resolve_parent(&target).await.map_err(status_of)?;
            conn.volume
                .rename(from_parent, from_name.as_bytes(), to_parent, to_name.as_bytes())
                .await
                .map_err(status_of)?;
            // The handle now names a different path, and a later
            // delete-on-close must follow the file, not the old name.
            if let Some(handle) = conn.handle_mut(id) {
                handle.path = target;
            }
        }

        other => {
            tracing::debug!("smb: unsupported set info class {other}");
            return Err(STATUS_INVALID_INFO_CLASS);
        }
    }

    let mut w = Writer::new();
    header.write_response(&mut w, STATUS_SUCCESS, header.credits.max(1));
    w.u16(2);
    Ok(w.buf)
}

/// Match a name against an SMB search pattern.
///
/// Only `*` and `?` are handled; the legacy DOS wildcards (`<`, `>`, `\"`)
/// exist for 8.3 name matching, which this server does not offer. An empty
/// pattern means "everything", as does `*`.
fn matches_pattern(pattern: &str, name: &str) -> bool {
    if pattern.is_empty() || pattern == "*" {
        return true;
    }
    let p: Vec<char> = pattern.chars().collect();
    let n: Vec<char> = name.chars().collect();

    // Iterative backtracking match, so a pattern full of stars cannot blow the
    // stack or go exponential on a long name.
    let (mut pi, mut ni) = (0usize, 0usize);
    let (mut star, mut resume) = (usize::MAX, 0usize);
    while ni < n.len() {
        if pi < p.len() && (p[pi] == '?' || p[pi] == n[ni]) {
            pi += 1;
            ni += 1;
        } else if pi < p.len() && p[pi] == '*' {
            star = pi;
            resume = ni;
            pi += 1;
        } else if star != usize::MAX {
            pi = star + 1;
            resume += 1;
            ni = resume;
        } else {
            return false;
        }
    }
    while pi < p.len() && p[pi] == '*' {
        pi += 1;
    }
    pi == p.len()
}

fn normalise(path: &str) -> String {
    let parts = super::session::split_path(path);
    format!("\\{}", parts.join("\\"))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn attr(kind: Kind, size: u64) -> Attr {
        Attr {
            ino: 42,
            kind,
            mode: 0o644,
            nlink: 1,
            uid: 0,
            gid: 0,
            size,
            atime: Timespec { secs: 1_700_000_000, nanos: 0 },
            mtime: Timespec { secs: 1_700_000_000, nanos: 0 },
            ctime: Timespec { secs: 1_700_000_000, nanos: 0 },
        }
    }

    #[test]
    fn patterns_match_the_way_clients_expect() {
        // The single-name case is what `stat` depends on.
        assert!(matches_pattern("a.txt", "a.txt"));
        assert!(!matches_pattern("a.txt", "b.txt"));
        assert!(!matches_pattern("a.txt", "a.txt.bak"));

        assert!(matches_pattern("*", "anything"));
        assert!(matches_pattern("", "anything"));
        assert!(matches_pattern("*.txt", "notes.txt"));
        assert!(!matches_pattern("*.txt", "notes.md"));
        assert!(matches_pattern("a?c", "abc"));
        assert!(!matches_pattern("a?c", "ac"));
        assert!(matches_pattern("*a*b*", "xxayybzz"));
        assert!(!matches_pattern("*a*b*c", "ab"));
    }

    #[test]
    fn pattern_matching_does_not_blow_up_on_many_stars() {
        let pattern = "*".repeat(40) + "z";
        assert!(!matches_pattern(&pattern, &"a".repeat(200)));
    }

    #[test]
    fn directory_entries_are_eight_byte_aligned() {
        // Windows walks the entry chain by NextEntryOffset and misparses the
        // whole listing if any entry is not aligned.
        for name in ["a", "ab", "abc", "abcd", "long-file-name.txt"] {
            let entry = encode_dir_entry(
                FILE_ID_BOTH_DIRECTORY_INFORMATION,
                name.as_bytes(),
                &attr(Kind::File, 10),
                true,
            )
            .unwrap();
            assert_eq!(entry.len() % 8, 0, "entry for {name:?} must be padded");
            let next = u32::from_le_bytes(entry[0..4].try_into().unwrap());
            assert_eq!(next as usize, entry.len());
        }
    }

    #[test]
    fn directory_flag_is_reported() {
        let entry =
            encode_dir_entry(FILE_BOTH_DIRECTORY_INFORMATION, b"d", &attr(Kind::Dir, 0), true)
                .unwrap();
        // FileAttributes sits after the 8-byte prefix, 4 timestamps, size, and
        // allocation size.
        let at = 8 + 32 + 8 + 8;
        let attrs = u32::from_le_bytes(entry[at..at + 4].try_into().unwrap());
        assert_eq!(attrs & FILE_ATTRIBUTE_DIRECTORY, FILE_ATTRIBUTE_DIRECTORY);
    }

    #[test]
    fn standard_information_has_the_expected_size() {
        // Clients reject a short structure outright.
        let body = file_info(FILE_STANDARD_INFORMATION, &attr(Kind::File, 100), "\\f", true).unwrap();
        assert_eq!(body.len(), 24);
    }

    #[test]
    fn basic_information_has_the_expected_size() {
        let body = file_info(FILE_BASIC_INFORMATION, &attr(Kind::File, 0), "\\f", true).unwrap();
        assert_eq!(body.len(), 40);
    }

    #[test]
    fn network_open_information_has_the_expected_size() {
        let body = file_info(FILE_NETWORK_OPEN_INFORMATION, &attr(Kind::File, 0), "\\f", true).unwrap();
        assert_eq!(body.len(), 56);
    }

    #[test]
    fn a_read_only_volume_says_so_everywhere_a_client_looks() {
        // A client decides whether to offer editing from these three answers.
        // If any of them claims write on a volume that refuses it, the mount
        // looks writable and the refusal arrives only after the user's work.
        let ro = file_info(FILE_BASIC_INFORMATION, &attr(Kind::File, 0), "\\f", false).unwrap();
        let attrs = u32::from_le_bytes(ro[32..36].try_into().unwrap());
        assert_eq!(attrs & FILE_ATTRIBUTE_READONLY, FILE_ATTRIBUTE_READONLY);

        let access = file_info(FILE_ACCESS_INFORMATION, &attr(Kind::File, 0), "\\f", false).unwrap();
        assert_eq!(u32::from_le_bytes(access[0..4].try_into().unwrap()), READ_ACCESS);

        let fs = fs_info(FS_ATTRIBUTE_INFORMATION, false, 1).unwrap();
        let flags = u32::from_le_bytes(fs[0..4].try_into().unwrap());
        assert_eq!(flags & FILE_READ_ONLY_VOLUME, FILE_READ_ONLY_VOLUME);

        let entry =
            encode_dir_entry(FILE_ID_BOTH_DIRECTORY_INFORMATION, b"f", &attr(Kind::File, 1), false)
                .unwrap();
        let at = 8 + 32 + 8 + 8;
        let listed = u32::from_le_bytes(entry[at..at + 4].try_into().unwrap());
        assert_eq!(listed & FILE_ATTRIBUTE_READONLY, FILE_ATTRIBUTE_READONLY);
    }

    #[test]
    fn a_writable_volume_is_not_marked_read_only() {
        let rw = file_info(FILE_BASIC_INFORMATION, &attr(Kind::File, 0), "\\f", true).unwrap();
        let attrs = u32::from_le_bytes(rw[32..36].try_into().unwrap());
        assert_eq!(attrs & FILE_ATTRIBUTE_READONLY, 0);

        let access = file_info(FILE_ACCESS_INFORMATION, &attr(Kind::File, 0), "\\f", true).unwrap();
        assert_eq!(u32::from_le_bytes(access[0..4].try_into().unwrap()), FULL_ACCESS);
    }

    #[test]
    fn volume_serial_comes_from_the_filesystem_identity() {
        let filesystem_id = 0x1234_5678_9abc_def0;
        let fs = fs_info(FS_VOLUME_INFORMATION, true, filesystem_id).unwrap();
        assert_eq!(u32::from_le_bytes(fs[8..12].try_into().unwrap()), 0x9abc_def0);
    }

    #[test]
    fn unknown_info_classes_are_rejected_not_guessed() {
        assert_eq!(file_info(200, &attr(Kind::File, 0), "\\f", true), Err(STATUS_INVALID_INFO_CLASS));
        assert_eq!(fs_info(99, true, 1), Err(STATUS_INVALID_INFO_CLASS));
    }
}
