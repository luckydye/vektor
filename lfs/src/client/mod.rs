//! Client side: turning a running server into a mounted filesystem, using each
//! OS's native NFS client so no kernel extension or driver has to be shipped.

pub mod mount;
