//! Device identity belongs to the local app, independently of optional sync.
use crate::{tokei_usage, usage_sync};
use serde::{Deserialize, Serialize};
use std::{collections::hash_map::RandomState, hash::BuildHasher, path::Path, sync::Mutex};
use tauri::Manager;

static LOCK: Mutex<()> = Mutex::new(());
const FILE: &str = "local-identity.json";

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Identity {
    device_id: String,
}

fn saved(data: &Path) -> Result<Option<String>, String> {
    let path = data.join(FILE);
    if !path
        .try_exists()
        .map_err(|_| "local_identity_unavailable")?
    {
        return Ok(None);
    }
    let identity: Identity = serde_json::from_value(tokei_usage::read_json(&path, 4096)?)
        .map_err(|_| "local_identity_invalid")?;
    if !usage_sync::safe_id(&identity.device_id) {
        return Err("local_identity_invalid".into());
    }
    Ok(Some(identity.device_id))
}

pub(crate) fn resolve(data: &Path, home: &Path) -> Result<String, String> {
    let _guard = LOCK.lock().map_err(|_| "local_identity_unavailable")?;
    // Existing server bindings are authoritative. Never rewrite or re-enroll them.
    if let Some(settings) = usage_sync::settings_at(data)? {
        if saved(data)?.is_none() {
            usage_sync::write_json(
                &data.join(FILE),
                &Identity {
                    device_id: settings.device_id.clone(),
                },
            )?;
        }
        return Ok(settings.device_id);
    }
    if let Some(id) = saved(data)? {
        return Ok(id);
    }
    let legacy = tokei_usage::read_json(&home.join(".tokei/config.json"), 256 * 1024).ok();
    let id = legacy
        .as_ref()
        .and_then(|v| v["device_id"].as_str())
        .filter(|id| usage_sync::safe_id(id))
        .map(str::to_owned)
        .unwrap_or_else(|| {
            // Independently seeded hashes provide an opaque local identifier, not
            // a credential. No hardware or provider account information is used.
            format!(
                "device-{:016x}{:016x}",
                RandomState::new().hash_one(0_u8),
                RandomState::new().hash_one(1_u8)
            )
        });
    usage_sync::write_json(
        &data.join(FILE),
        &Identity {
            device_id: id.clone(),
        },
    )?;
    Ok(id)
}

pub(crate) fn conflicting_ids(
    data: &Path,
    home: &Path,
    resolved: &str,
) -> Result<Vec<String>, String> {
    let mut ids: Vec<_> = saved(data)?
        .into_iter()
        .filter(|id| id != resolved)
        .collect();
    if let Ok(legacy) = tokei_usage::read_json(&home.join(".tokei/config.json"), 256 * 1024) {
        if let Some(id) = legacy["device_id"]
            .as_str()
            .filter(|id| usage_sync::safe_id(id) && *id != resolved)
        {
            if !ids.iter().any(|other| other == id) {
                ids.push(id.to_owned());
            }
        }
    }
    Ok(ids)
}

#[tauri::command]
pub fn get_local_device_id(app: tauri::AppHandle) -> Result<String, String> {
    let data = app
        .path()
        .app_config_dir()
        .map_err(|_| "local_identity_unavailable")?;
    resolve(&data, &dirs::home_dir().ok_or("home_unavailable")?)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn legacy_and_bound_identities_are_reused_without_remapping_conflicts() {
        let root = std::env::temp_dir().canonicalize().unwrap().join(format!(
            "identity-{}-{}",
            std::process::id(),
            RandomState::new().hash_one(0_u8)
        ));
        std::fs::create_dir_all(root.join(".tokei")).unwrap();
        usage_sync::write_json(
            &root.join(".tokei/config.json"),
            &serde_json::json!({"device_id":"legacy-test-device"}),
        )
        .unwrap();
        assert_eq!(resolve(&root, &root).unwrap(), "legacy-test-device");
        usage_sync::write_json(&root.join("usage-sync.json"), &serde_json::json!({"enabled":false,"deviceId":"bound-test-device","intervalSeconds":300,"remote":"git@github.com:example/usage.git","branch":"main"})).unwrap();
        assert_eq!(resolve(&root, &root).unwrap(), "bound-test-device");
        assert_eq!(
            conflicting_ids(&root, &root, "bound-test-device").unwrap(),
            vec!["legacy-test-device"]
        );
        assert_eq!(saved(&root).unwrap().as_deref(), Some("legacy-test-device"));
        std::fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn concurrent_initialization_is_stable_and_does_not_configure_sync() {
        let root = std::env::temp_dir().canonicalize().unwrap().join(format!(
            "identity-{}-{}",
            std::process::id(),
            RandomState::new().hash_one(0_u8)
        ));
        std::fs::create_dir_all(&root).unwrap();
        let ids = std::thread::scope(|scope| {
            let handles: Vec<_> = (0..8)
                .map(|_| scope.spawn(|| resolve(&root, &root).unwrap()))
                .collect();
            handles
                .into_iter()
                .map(|h| h.join().unwrap())
                .collect::<Vec<_>>()
        });
        assert!(ids.iter().all(|id| id == &ids[0]));
        assert_eq!(resolve(&root, &root).unwrap(), ids[0]);
        assert!(usage_sync::settings_at(&root).unwrap().is_none());
        std::fs::write(root.join(FILE), "invalid").unwrap();
        assert!(resolve(&root, &root).is_err());
        std::fs::remove_dir_all(root).unwrap();
    }
}
