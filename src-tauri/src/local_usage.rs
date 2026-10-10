//! One aggregate-only read path for usage panels, member settings and feedback.
use crate::{
    codex_project_usage::ProjectUsageSnapshot,
    local_identity, shared_settings,
    tokei_usage::{self, DeviceUsage, TokeiUsage},
    usage_sync, usage_sync_snapshot,
};
use chrono::{Local, NaiveDate};
use sha2::{Digest, Sha256};
use std::{path::PathBuf, sync::Mutex};

static MERGE_LOCK: Mutex<()> = Mutex::new(());
const CACHE: &str = "local-usage-cache.json";

// Configuration boundary only, not account verification. No credentials are read.
fn profile_scope(home: &std::path::Path) -> Option<String> {
    let path = std::env::var_os("CODEX_HOME")
        .map(PathBuf::from)
        .unwrap_or_else(|| home.join(".codex"));
    let canonical = path.canonicalize().ok()?;
    Some(format!(
        "{:x}",
        Sha256::digest(canonical.to_string_lossy().as_bytes())
    ))
}

/// Pure projection: never sum a rescan with the previous copy of the same day.
fn project(
    id: &str,
    collected: &ProjectUsageSnapshot,
    previous: Option<&DeviceUsage>,
    today: NaiveDate,
) -> Result<DeviceUsage, String> {
    if collected.device_id.as_deref() != Some(id) {
        return Err("local_identity_changed".into());
    }
    if let Some(previous) = previous.filter(|device| {
        device
            .updated_at
            .as_deref()
            .and_then(|s| chrono::DateTime::parse_from_rfc3339(s).ok())
            .zip(chrono::DateTime::parse_from_rfc3339(&collected.updated_at).ok())
            .is_some_and(|(old, new)| old > new)
    }) {
        return Ok(previous.clone());
    }
    let baselines: Vec<_> = previous
        .map(usage_sync_snapshot::device_baseline)
        .into_iter()
        .collect();
    let value = usage_sync_snapshot::build_local_at(id, collected, &baselines, today)?;
    let mut device = tokei_usage::parse_device(&value, id, None).ok_or("local_usage_invalid")?;
    device.updated_at = Some(collected.updated_at.clone());
    Ok(device)
}

fn previous_device(
    existing: Option<&DeviceUsage>,
    cached: Option<&DeviceUsage>,
) -> Option<DeviceUsage> {
    let mut previous = match (existing, cached) {
        (Some(a), Some(b)) if b.updated_at > a.updated_at => Some(b),
        (Some(a), _) => Some(a),
        (None, b) => b,
    }
    .cloned()?;
    for baseline in [existing, cached].into_iter().flatten() {
        for (target, source) in [
            (&mut previous.daily, &baseline.daily),
            (&mut previous.ranges, &baseline.ranges),
        ] {
            for (key, period) in source {
                if target.get(key).is_none_or(|old| {
                    period.metrics.total_tokens > old.metrics.total_tokens
                        || (period.metrics.total_tokens == old.metrics.total_tokens
                            && old.metrics.estimated_cost_usd.is_none()
                            && period.metrics.estimated_cost_usd.is_some())
                }) {
                    target.insert(key.clone(), period.clone());
                }
            }
        }
    }
    Some(previous)
}

pub(crate) async fn read(data: PathBuf, home: PathBuf) -> Result<TokeiUsage, String> {
    let source = data.clone();
    let (mut usage, id) = tauri::async_runtime::spawn_blocking(move || {
        let id = local_identity::resolve(&source, &home)?;
        let groups = shared_settings::ensure_local_person(&source, &id)?;
        let mut usage = tokei_usage::load_usage(&home, groups);
        usage_sync::merge_managed_usage(&source, &mut usage);
        usage.local_group_id = tokei_usage::local_group_id(&usage.groups, Some(&id));
        usage.local_device_id = Some(id.clone());
        usage.local_profile_scope = profile_scope(&home);
        usage.local_only = usage_sync::settings_at(&source)?.is_none();
        usage
            .warnings
            .retain(|w| w != "config_unavailable" && w != "sync_unavailable");
        let conflicts = local_identity::conflicting_ids(&source, &home, &id)?;
        if !conflicts.is_empty() {
            usage.warnings.push("local_identity_conflict".into());
            usage
                .devices
                .retain(|device| !conflicts.contains(&device.id));
        }
        Ok::<_, String>((usage, id))
    })
    .await
    .map_err(|_| "source_unavailable")??;
    // Reuse the bounded, cached collector. No sync/upload function is called.
    let collected = tokio::time::timeout(
        std::time::Duration::from_secs(20),
        usage_sync::collect_local_usage(&data),
    )
    .await
    .unwrap_or_else(|_| Err("collector_timeout".into()));
    tauri::async_runtime::spawn_blocking(move || {
        let _guard = MERGE_LOCK.lock().map_err(|_| "local_usage_unavailable")?;
        let cached = tokei_usage::read_json(&data.join(CACHE), 8 * 1024 * 1024)
            .ok()
            .filter(|v| v["_device"].as_str() == Some(&id))
            .and_then(|v| tokei_usage::parse_device(&v, &id, None));
        let index = usage.devices.iter().position(|d| d.id == id);
        let existing = index.map(|i| &usage.devices[i]);
        let previous = previous_device(existing, cached.as_ref());
        let projected = collected
            .as_ref()
            .map_err(Clone::clone)
            .and_then(|snapshot| {
                if snapshot.status == "unavailable" {
                    return Err("local_usage_unavailable".into());
                }
                project(&id, snapshot, previous.as_ref(), Local::now().date_naive())
            });
        let device = match projected {
            Ok(device) => {
                usage.local_usage_status = Some(
                    if device.collection_partial {
                        "partial"
                    } else {
                        "ready"
                    }
                    .into(),
                );
                if usage_sync::write_json(
                    &data.join(CACHE),
                    &usage_sync_snapshot::device_baseline(&device),
                )
                .is_err()
                {
                    usage.warnings.push("local_usage_cache_unavailable".into());
                }
                Some(device)
            }
            Err(_) => {
                let empty = collected
                    .as_ref()
                    .is_ok_and(|s| s.projects.is_empty() && s.warnings.is_empty());
                usage.local_usage_status = Some(if empty { "empty" } else { "unavailable" }.into());
                if !empty {
                    usage.warnings.push("local_collection_unavailable".into());
                }
                previous.map(|mut device| {
                    device.stale = true;
                    device
                })
            }
        };
        if let Some(device) = device {
            if let Some(index) = index {
                usage.devices[index] = device;
            } else {
                usage.devices.push(device);
            }
        }
        usage.status = if usage.devices.is_empty() {
            "unavailable"
        } else if !usage.warnings.is_empty()
            || usage
                .devices
                .iter()
                .any(|d| d.stale || d.collection_partial)
        {
            "partial"
        } else {
            "ready"
        }
        .into();
        Ok(usage)
    })
    .await
    .map_err(|_| "source_unavailable")?
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{
        codex_project_usage::ProjectUsage,
        tokei_usage::{Metrics, ModelUsage, UsagePeriod},
    };
    use std::collections::BTreeMap;

    fn fixture(tokens: u64, partial: bool) -> ProjectUsageSnapshot {
        let metrics = Metrics {
            input_tokens: tokens,
            cached_input_tokens: 0,
            output_tokens: 0,
            reasoning_tokens: 0,
            total_tokens: tokens,
            estimated_cost_usd: None,
        };
        ProjectUsageSnapshot {
            device_id: Some("local-test-device".into()),
            updated_at: "2026-09-10T04:00:00Z".into(),
            status: if partial { "partial" } else { "ready" }.into(),
            coverage: "local".into(),
            scanned_files: 1,
            pricing_source: "test".into(),
            pricing_updated_at: None,
            task_metadata_coverage: "complete".into(),
            warnings: if partial {
                vec!["scan_limit".into()]
            } else {
                vec![]
            },
            tasks: vec![],
            peer_tasks: vec![],
            projects: vec![ProjectUsage {
                id: "project-a".into(),
                name: "Synthetic project".into(),
                daily: BTreeMap::from([(
                    "2026-09-09".into(),
                    UsagePeriod {
                        start: None,
                        end: None,
                        metrics: metrics.clone(),
                        models: vec![ModelUsage {
                            id: "unknown".into(),
                            name: "Unknown".into(),
                            metrics,
                        }],
                    },
                )]),
            }],
        }
    }

    #[test]
    fn first_local_scan_needs_no_existing_device_and_keeps_unknown_cost() {
        let day = NaiveDate::from_ymd_opt(2026, 9, 10).unwrap();
        let result = project("local-test-device", &fixture(100, false), None, day).unwrap();
        assert_eq!(result.daily["2026-09-09"].metrics.total_tokens, 100);
        assert_eq!(result.daily["2026-09-09"].metrics.estimated_cost_usd, None);
        assert_eq!(
            result.daily["2026-09-09"].models[0].metrics.total_tokens,
            100
        );
        let again = project(
            "local-test-device",
            &fixture(100, false),
            Some(&result),
            day,
        )
        .unwrap();
        assert_eq!(again.daily["2026-09-09"].metrics.total_tokens, 100);
    }

    #[test]
    fn partial_prefix_preserves_complete_history_and_is_explicit() {
        let day = NaiveDate::from_ymd_opt(2026, 9, 10).unwrap();
        let old = project("local-test-device", &fixture(500, false), None, day).unwrap();
        let partial = project("local-test-device", &fixture(100, true), Some(&old), day).unwrap();
        assert_eq!(partial.daily["2026-09-09"].metrics.total_tokens, 500);
        assert!(partial.collection_partial);
        let first = project("local-test-device", &fixture(100, true), None, day).unwrap();
        assert_eq!(first.daily["2026-09-09"].metrics.total_tokens, 100);
        assert!(first.collection_partial);
        let ready = project(
            "local-test-device",
            &fixture(800, false),
            Some(&partial),
            day,
        )
        .unwrap();
        assert_eq!(ready.daily["2026-09-09"].metrics.total_tokens, 800);
        assert!(!ready.collection_partial);
    }

    #[test]
    fn unknown_model_cost_does_not_freeze_known_token_totals() {
        let date = NaiveDate::from_ymd_opt(2026, 9, 10).unwrap();
        let mut previous = project("local-test-device", &fixture(500, false), None, date).unwrap();
        previous
            .daily
            .get_mut("2026-09-09")
            .unwrap()
            .metrics
            .estimated_cost_usd = Some(1.0);
        let mut next = fixture(800, true);
        next.warnings = vec!["unknown_model".into()];
        let result = project("local-test-device", &next, Some(&previous), date).unwrap();
        assert_eq!(result.daily["2026-09-09"].metrics.total_tokens, 800);
        assert_eq!(result.daily["2026-09-09"].metrics.estimated_cost_usd, None);
        assert_eq!(result.ranges["all"].metrics.total_tokens, 800);
    }

    #[test]
    fn newer_partial_cache_does_not_hide_complete_synced_history() {
        let day = NaiveDate::from_ymd_opt(2026, 9, 10).unwrap();
        let complete = project("local-test-device", &fixture(500, false), None, day).unwrap();
        let mut partial = project("local-test-device", &fixture(100, true), None, day).unwrap();
        partial.updated_at = Some("2026-09-10T05:00:00Z".into());
        let retained = previous_device(Some(&complete), Some(&partial)).unwrap();
        assert_eq!(retained.daily["2026-09-09"].metrics.total_tokens, 500);
        assert_eq!(retained.ranges["all"].metrics.total_tokens, 500);
    }
}
