//! Filesystem-level errors. Deliberately protocol-agnostic: nothing in here
//! knows about NFS status codes, and nothing in here knows about S3.

use std::fmt;

#[derive(Debug)]
pub enum FsError {
    NotFound,
    Exists,
    NotDir,
    IsDir,
    NotEmpty,
    Inval,
    NoSpace,
    /// The filesystem, or this object within it, cannot be modified.
    ReadOnly,
    Io(std::io::Error),
    Backend(String),
    Corrupt(String),
}

pub type Result<T> = std::result::Result<T, FsError>;

impl fmt::Display for FsError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            FsError::NotFound => write!(f, "no such file or directory"),
            FsError::Exists => write!(f, "file exists"),
            FsError::NotDir => write!(f, "not a directory"),
            FsError::IsDir => write!(f, "is a directory"),
            FsError::NotEmpty => write!(f, "directory not empty"),
            FsError::Inval => write!(f, "invalid argument"),
            FsError::NoSpace => write!(f, "no space left on device"),
            FsError::ReadOnly => write!(f, "read-only filesystem"),
            FsError::Io(e) => write!(f, "io error: {e}"),
            FsError::Backend(m) => write!(f, "backend error: {m}"),
            FsError::Corrupt(m) => write!(f, "corrupt state: {m}"),
        }
    }
}

impl std::error::Error for FsError {}

impl From<std::io::Error> for FsError {
    fn from(e: std::io::Error) -> Self {
        FsError::Io(e)
    }
}

impl From<object_store::Error> for FsError {
    fn from(e: object_store::Error) -> Self {
        match e {
            object_store::Error::NotFound { .. } => FsError::NotFound,
            other => FsError::Backend(other.to_string()),
        }
    }
}

impl From<postcard::Error> for FsError {
    fn from(e: postcard::Error) -> Self {
        FsError::Corrupt(e.to_string())
    }
}
