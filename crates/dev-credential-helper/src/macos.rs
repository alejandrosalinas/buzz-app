//! The peer check and the Keychain calls. Nothing here logs, and no value is
//! written anywhere but the app's socket.
use crate::policy::{Operation, Request, ABSENT, CORRUPT, DENIED, LIMIT, OCCUPIED, UNAVAILABLE};
use core_foundation::base::TCFType;
use core_foundation::data::CFData;
use security_framework::os::macos::code_signing::{
    Flags, GuestAttributes, SecCode, SecRequirement,
};
use security_framework::os::macos::keychain::SecKeychain;
use std::io::{Read, Write};
use std::os::fd::FromRawFd;
use std::os::unix::fs::{MetadataExt, PermissionsExt};
use std::os::unix::net::UnixStream;
use zeroize::Zeroizing;

// <sys/un.h>
const SOL_LOCAL: libc::c_int = 0;
const LOCAL_PEERTOKEN: libc::c_int = 0x006;

const NOT_FOUND: i32 = -25300;
const DUPLICATE: i32 = -25299;
const AUTH_FAILED: i32 = -25293;
const INTERACTION_NOT_ALLOWED: i32 = -25308;
const USER_CANCELED: i32 = -128;

pub fn run(request: &Request) -> i32 {
    if let Err(code) = verify_peer() {
        return code;
    }
    // SAFETY: fd 1 was just checked to be a socket; the helper owns it from here.
    let mut socket = unsafe { UnixStream::from_raw_fd(1) };
    let mut value = Zeroizing::new(Vec::new());
    if request.operation.takes_value() {
        if (&mut socket)
            .take(LIMIT as u64 + 1)
            .read_to_end(&mut value)
            .is_err()
        {
            return UNAVAILABLE;
        }
        if value.len() > LIMIT {
            return CORRUPT;
        }
    }
    match keychain(request, &value) {
        Ok(output) if output.len() > LIMIT => CORRUPT,
        Ok(output) => match socket.write_all(&output) {
            Ok(()) => 0,
            Err(_) => UNAVAILABLE,
        },
        Err(status) => code(status),
    }
}

fn code(status: i32) -> i32 {
    match status {
        NOT_FOUND => ABSENT,
        DUPLICATE => OCCUPIED,
        USER_CANCELED | AUTH_FAILED | INTERACTION_NOT_ALLOWED => DENIED,
        _ => UNAVAILABLE,
    }
}

/// Serve only the process that started this helper, over the socket it made,
/// and only when its live code signature meets the configured requirement.
fn verify_peer() -> Result<(), i32> {
    // SAFETY: plain libc calls on fd 1 with correctly sized out-parameters.
    unsafe {
        let mut stat: libc::stat = std::mem::zeroed();
        if libc::fstat(1, &mut stat) != 0 || stat.st_mode & libc::S_IFMT != libc::S_IFSOCK {
            return Err(DENIED);
        }
        let mut token = [0u32; 8];
        let mut length = std::mem::size_of_val(&token) as libc::socklen_t;
        if libc::getsockopt(
            1,
            SOL_LOCAL,
            LOCAL_PEERTOKEN,
            token.as_mut_ptr().cast(),
            &mut length,
        ) != 0
            || length as usize != std::mem::size_of_val(&token)
        {
            return Err(DENIED);
        }
        // audit_token_t: auid, euid, egid, ruid, rgid, pid, asid, pidversion.
        if token[5] as libc::pid_t != libc::getppid() || token[1] != libc::geteuid() {
            return Err(DENIED);
        }
        let requirement: SecRequirement = requirement()?.parse().map_err(|_| UNAVAILABLE)?;
        let bytes: Vec<u8> = token.iter().flat_map(|word| word.to_ne_bytes()).collect();
        let token = CFData::from_buffer(&bytes);
        let mut attributes = GuestAttributes::new();
        attributes.set_audit_token(token.as_concrete_TypeRef());
        SecCode::copy_guest_with_attribues(None, &attributes, Flags::NONE)
            .and_then(|code| code.check_validity(Flags::NONE, &requirement))
            .map_err(|_| DENIED)
    }
}

/// The code requirement `just desktop me` wrote at setup. It must belong to
/// this user and be writable by no one else.
fn requirement() -> Result<String, i32> {
    let user = nix::unistd::User::from_uid(nix::unistd::Uid::effective())
        .ok()
        .flatten()
        .ok_or(UNAVAILABLE)?;
    let path = user
        .dir
        .join(".buzz-foundation/dev-credential-helper/requirement");
    let metadata = std::fs::symlink_metadata(&path).map_err(|_| UNAVAILABLE)?;
    if !metadata.is_file()
        || metadata.uid() != user.uid.as_raw()
        || metadata.permissions().mode() & 0o022 != 0
    {
        return Err(UNAVAILABLE);
    }
    let text = std::fs::read_to_string(&path).map_err(|_| UNAVAILABLE)?;
    let text = text.trim();
    if text.is_empty() {
        return Err(UNAVAILABLE);
    }
    Ok(text.to_owned())
}

/// Run the request with Keychain dialogs off. Only an item that still needs
/// approval, under `--authorize`, is tried once more with a dialog allowed.
fn keychain(request: &Request, value: &[u8]) -> Result<Zeroizing<Vec<u8>>, i32> {
    let quiet = {
        let _quiet = SecKeychain::disable_user_interaction().map_err(|_| 0)?;
        operate(request, value)
    };
    match quiet {
        Err(AUTH_FAILED | INTERACTION_NOT_ALLOWED) if request.authorize => operate(request, value),
        result => result,
    }
}

fn operate(request: &Request, value: &[u8]) -> Result<Zeroizing<Vec<u8>>, i32> {
    let status = |error: security_framework::base::Error| error.code();
    let keychain = SecKeychain::default().map_err(status)?;
    let (service, account) = (request.service.as_str(), request.account.as_str());
    let none = || Zeroizing::new(Vec::new());
    match request.operation {
        Operation::Read => keychain
            .find_generic_password(service, account)
            .map(|(password, _)| Zeroizing::new(password.to_vec()))
            .map_err(status),
        Operation::Add => keychain
            .add_generic_password(service, account, value)
            .map(|()| none())
            .map_err(status),
        // In place, so the item keeps its access list and a failed write keeps it.
        Operation::Replace => match keychain.find_generic_password(service, account) {
            Ok((_, mut item)) => item.set_password(value).map(|()| none()).map_err(status),
            Err(error) if error.code() == NOT_FOUND => keychain
                .add_generic_password(service, account, value)
                .map(|()| none())
                .map_err(status),
            Err(error) => Err(error.code()),
        },
        // Keychain's delete reports no failure, so confirm the item is gone.
        Operation::Delete => {
            let (_, item) = keychain
                .find_generic_password(service, account)
                .map_err(status)?;
            item.delete();
            match keychain.find_generic_password(service, account) {
                Ok(_) => Err(0),
                Err(error) if error.code() == NOT_FOUND => Ok(none()),
                Err(error) => Err(error.code()),
            }
        }
    }
}
