//! Share-compute picker, adapting Buzz's curated ladder to the pinned SDK catalog.
use mesh_llm_host_runtime::models::{self, remote_catalog::RemoteCatalogModel};
use mesh_llm_system::{hardware, vram};
use serde::Serialize;
use std::collections::HashSet;

const CURATED_SMALL: &str = "unsloth/gemma-4-E4B-it-GGUF:Q4_K_M";
const CURATED_MEDIUM: &str = "unsloth/Qwen3.5-9B-GGUF:Q4_K_M";
const CURATED_LARGE: &str = "unsloth/Qwen3.8-27B-GGUF:UD-Q4_K_M";
const GEMMA_TINY: &str = "unsloth/gemma-4-E2B-it-GGUF:Q4_K_M";
const GEMMA_DENSE: &str = "unsloth/gemma-4-31B-it-GGUF:Q4_K_M";
const GEMMA_MOE: &str = "unsloth/gemma-4-26B-A4B-it-GGUF:UD-Q4_K_M";
const LEGACY_LARGE_XL: &str = "unsloth/Qwen3.8-27B-GGUF:UD-Q4_K_XL";

/// Rated-capacity boundary for the balanced Qwen3.5 9B tier.
const CURATED_MEDIUM_MIN_RATED_GB: u64 = 32;
/// Qwen3.8 27B is recommended for 64 GB-and-larger rated capacity classes,
/// leaving headroom for KV cache and runtime use (Buzz donor 639593bba).
const CURATED_LARGE_MIN_RATED_GB: u64 = 64;

/// Preserve the historical Buzz aliases at the native sharing boundary.
pub fn canonical_curated_model_id(model: &str) -> &str {
    match model.trim() {
        "Gemma-4-E4B-it-Q4_K_M" => CURATED_SMALL,
        "Qwen3.5-9B-Vision-Q4_K_M" => CURATED_MEDIUM,
        "Qwen3.8-27B-Q4_K_M" => "unsloth/Qwen3.8-27B-GGUF:Q4_K_M",
        "gemma-4-26B-A4B-it-UD-Q4_K_M" => GEMMA_MOE,
        other => other,
    }
}

/// Older pickers persisted these recommendations without an explicit Auto mode.
pub fn is_legacy_recommendation(model: &str) -> bool {
    matches!(
        model,
        CURATED_SMALL | CURATED_MEDIUM | CURATED_LARGE | LEGACY_LARGE_XL
    )
}

/// Hardware-ranked models with cache evidence, not a claim of runtime readiness.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Catalog {
    pub gpu_name: Option<String>,
    pub vram_display: String,
    pub recommended: Option<String>,
    pub entries: Vec<Entry>,
    pub hosting: Option<Hosting>,
}

/// Conservative first-run choices. This is a planning budget, not an OS memory limit.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Hosting {
    pub memory_display: String,
    pub max_vram_gb: u64,
    pub model: Option<String>,
}

fn hosting_survey() -> hardware::HardwareSurvey {
    let survey = hardware::survey();
    #[cfg(all(target_os = "macos", target_arch = "aarch64"))]
    let survey = {
        let mut survey = survey;
        // mesh-llm 0.78.1 omits physical RAM on macOS. Metal's working-set
        // budget cannot substitute for it when calculating the 25% share.
        if survey.is_soc && survey.system_ram_bytes.is_none() {
            survey.system_ram_bytes = std::process::Command::new("/usr/sbin/sysctl")
                .args(["-n", "hw.memsize"])
                .output()
                .ok()
                .filter(|output| output.status.success())
                .and_then(|output| String::from_utf8(output.stdout).ok())
                .and_then(|value| value.trim().parse::<u64>().ok())
                .filter(|bytes| *bytes > 0);
        }
        survey
    };
    survey
}

/// Models Auto may host: Gemma 4, which has native tool calls (Gemma 3's
/// template has no tool role, so agent turns fail after their first tool
/// call). The dense 31B is slow for agent loops, so it is only for machines
/// with a 64 GB budget (256 GB); below that the 26B-A4B MoE is the top rung.
fn auto_hosts(model: &str, max_vram_gb: u64) -> bool {
    let model = model.to_ascii_lowercase();
    model.starts_with("unsloth/gemma-4-") && (!model.contains("31b") || max_vram_gb >= 64)
}

/// Whether a catalog size label is a positive, finite GB/MB byte size.
fn byte_size(label: &str) -> bool {
    let upper = label.trim().to_ascii_uppercase();
    (upper.ends_with("GB") || upper.ends_with("MB")) && {
        let size = models::catalog::parse_size_gb(label);
        size.is_finite() && size > 0.0
    }
}

/// Memory the picker and the fallback ladder rate. A discrete GPU is rated by
/// its own VRAM: the survey's aggregate `vram_bytes` can include system RAM
/// (a 12 GB card was shown as 32 GB), which models never offload into.
/// Unified-memory machines keep the survey's Metal working set.
fn device_memory_bytes(survey: &hardware::HardwareSurvey) -> u64 {
    let discrete: u64 = survey.gpus.iter().map(|gpu| gpu.vram_bytes).sum();
    if survey.is_soc || discrete == 0 {
        survey.vram_bytes
    } else {
        discrete
    }
}

fn hosting(survey: &hardware::HardwareSurvey, entries: &[Entry]) -> Hosting {
    // Metal's usable working set is not physical memory. Unified-memory machines
    // use reported system RAM; discrete GPUs use device VRAM, never RAM offload.
    let bytes = if survey.is_soc {
        survey.system_ram_bytes.unwrap_or(0)
    } else {
        survey.gpus.iter().map(|gpu| gpu.vram_bytes).sum()
    };
    let max_vram_gb =
        (bytes / 4 / 1_000_000_000).min(vram::rated_capacity_gb(bytes).unwrap_or(0) / 4);
    let mut choices: Vec<_> = entries
        .iter()
        .filter_map(|entry| {
            let label = entry.size.as_deref()?;
            // Catalog descriptions such as "30 layers" are not byte sizes.
            if !byte_size(label) {
                return None;
            }
            let size = models::catalog::parse_size_gb(label);
            // Reserve another quarter of the model budget for context/runtime overhead.
            // Missing metadata is not fit evidence; 8 GB machines remain consumers.
            (bytes >= 16_000_000_000
                && size.is_finite()
                && size > 0.0
                && size <= max_vram_gb as f64 * 0.75
                && auto_hosts(&entry.model, max_vram_gb))
            .then_some((entry, size))
        })
        .collect();
    choices.sort_by(|a, b| b.1.total_cmp(&a.1).then(a.0.model.cmp(&b.0.model)));
    Hosting {
        memory_display: vram::format_rated_capacity(bytes),
        max_vram_gb,
        model: choices.first().map(|(entry, _)| entry.model.clone()),
    }
}

/// One exact, downloadable model choice from the SDK's catalog.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Entry {
    pub model: String,
    pub name: String,
    pub size: Option<String>,
    pub description: Option<String>,
    pub installed: bool,
    pub curated: bool,
    pub fit: &'static str,
}

/// Runs blocking hardware/cache/catalog I/O; callers must use a blocking task.
pub fn catalog() -> anyhow::Result<Catalog> {
    // The remote layer catalog enriches choices; it does not own Buzz's GGUF ladder.
    if let Err(error) = models::remote_catalog::ensure_catalog() {
        eprintln!("Mesh catalog metadata unavailable: {error}");
    }
    let survey = hosting_survey();
    let mut result = build(
        survey.gpu_name.clone(),
        device_memory_bytes(&survey),
        models::remote_catalog::loaded_models().unwrap_or_default(),
        installed_matcher(models::scan_installed_models()),
    );
    let hosting = hosting(&survey, &result.entries);
    // Auto's hosting choice is the recommendation the picker shows first.
    if let Some(model) = &hosting.model {
        result.recommended = Some(model.clone());
        if let Some(index) = result.entries.iter().position(|e| &e.model == model) {
            let entry = result.entries.remove(index);
            result.entries.insert(0, entry);
        }
    }
    result.hosting = Some(hosting);
    Ok(result)
}

/// Answers "is this reference already downloaded?" for the whole catalog from one
/// installed-model scan.
///
/// Probing `find_model_path` for each entry instead rescanned the entire Hugging
/// Face cache once per entry — twice on a miss — which outran the picker's 30 s
/// deadline when the cache is large or on network storage. `scan_installed_models`
/// already covers every layout a chosen model can live in: HF hub snapshots and
/// GGUF files at the cache root.
fn installed_matcher(installed: Vec<String>) -> impl Fn(&str) -> bool {
    let installed: HashSet<String> = installed
        .into_iter()
        .map(|name| canonical_curated_model_id(&name).to_owned())
        .collect();
    move |model| installed.contains(model)
}

fn exact_quant(file: &str, quant: &str) -> bool {
    let file = file.to_ascii_uppercase();
    let quant = quant.to_ascii_uppercase();
    file.match_indices(&quant).any(|(offset, _)| {
        let prefix = &file[..offset];
        let suffix = &file[offset + quant.len()..];
        (prefix.is_empty() || prefix.ends_with(['-', '.', '_']))
            && !prefix.ends_with("UD-")
            && (suffix.is_empty() || suffix.starts_with(['-', '.']))
    })
}

fn fit(size: Option<&str>, memory: f64) -> &'static str {
    let gb = size.map(models::catalog::parse_size_gb).unwrap_or(0.0);
    if gb <= 0.0 || memory <= 0.0 {
        "unknown"
    } else if gb <= memory * 0.6 {
        "comfortable"
    } else if gb <= memory * 0.9 {
        "tight"
    } else if gb <= memory * 1.1 {
        "tradeoff"
    } else {
        "too_large"
    }
}
fn fit_rank(fit: &str) -> u8 {
    match fit {
        "comfortable" => 0,
        "tight" => 1,
        "tradeoff" => 2,
        "too_large" => 3,
        _ => 4,
    }
}
/// Device recommendation uses Buzz's hardware ladder, not remote catalog availability.
/// This performs only a local hardware survey; serving owns artifact acquisition.
pub fn recommended_model() -> AutoChoice {
    let survey = hosting_survey();
    // Locally cached catalog only; the seeded Gemma sizes keep this offline-safe.
    let entries = build(
        None,
        device_memory_bytes(&survey),
        models::remote_catalog::loaded_models().unwrap_or_default(),
        |_| false,
    )
    .entries;
    auto_choice(&survey, &entries)
}

/// Auto's model and serving budget. `max_vram_gb` is None when the hosting
/// policy finds no fitting Gemma and the legacy ladder is the fallback.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AutoChoice {
    pub model: String,
    pub max_vram_gb: Option<u64>,
}

fn auto_choice(survey: &hardware::HardwareSurvey, entries: &[Entry]) -> AutoChoice {
    let hosting = hosting(survey, entries);
    match hosting.model {
        Some(model) => AutoChoice {
            model,
            max_vram_gb: Some(hosting.max_vram_gb),
        },
        // 16 GB fits no rung inside the budget (E2B is 3.11 GB of 3); it
        // still hosts the smallest Gemma 4 rather than a larger fallback.
        None if hosting.max_vram_gb >= 4 => AutoChoice {
            model: GEMMA_TINY.to_owned(),
            max_vram_gb: Some(hosting.max_vram_gb),
        },
        None => AutoChoice {
            model: recommendation_for_memory(device_memory_bytes(survey)).to_owned(),
            max_vram_gb: None,
        },
    }
}

fn recommendation_for_memory(bytes: u64) -> &'static str {
    match vram::rated_capacity_gb(bytes) {
        Some(gb) if gb >= CURATED_LARGE_MIN_RATED_GB => CURATED_LARGE,
        Some(gb) if gb >= CURATED_MEDIUM_MIN_RATED_GB => CURATED_MEDIUM,
        _ => CURATED_SMALL,
    }
}

fn build(
    gpu_name: Option<String>,
    bytes: u64,
    models: Vec<RemoteCatalogModel>,
    installed: impl Fn(&str) -> bool,
) -> Catalog {
    let recommendation = recommendation_for_memory(bytes);
    let mut entries: Vec<Entry> = models
        .iter()
        .filter(|model| {
            !models
                .iter()
                .any(|other| other.draft.as_deref() == Some(model.name.as_str()))
                || model.draft.is_some()
        })
        .map(|model| {
            // Curated choices preserve the donor's ingress refs; other choices use exact SDK refs.
            let curated = [CURATED_SMALL, CURATED_MEDIUM, CURATED_LARGE]
                .into_iter()
                .find(|reference| {
                    reference.split_once(':').is_some_and(|(repo, quant)| {
                        model.repo == repo && exact_quant(&model.source_file, quant)
                    })
                });
            let reference = curated
                .map(str::to_owned)
                .unwrap_or_else(|| model.exact_ref());
            Entry {
                installed: installed(&reference),
                model: reference,
                name: model.name.clone(),
                size: model.size.clone(),
                description: model.description.clone(),
                curated: curated.is_some(),
                fit: fit(model.size.as_deref(), bytes as f64 / 1e9),
            }
        })
        .collect();
    // Curated GGUF refs are resolved by Mesh at serving time, independently of
    // whether its remote layer-package catalog happens to list that quant.
    for reference in [CURATED_LARGE, CURATED_MEDIUM, CURATED_SMALL] {
        if !entries.iter().any(|entry| entry.model == reference) {
            entries.push(Entry {
                model: reference.into(),
                name: reference.into(),
                size: None,
                description: None,
                installed: installed(reference),
                curated: true,
                fit: "unknown",
            });
        }
    }
    // Exact Q4 artifacts verified against their Hugging Face file listings.
    // Keep the Gemma 4 rungs available when layer metadata omits their sizes.
    for (reference, name, size) in [
        (GEMMA_TINY, "Gemma 4 E2B", "3.11GB"),
        (CURATED_SMALL, "Gemma 4 E4B", "4.98GB"),
        (GEMMA_MOE, "Gemma 4 26B-A4B", "16.95GB"),
        (GEMMA_DENSE, "Gemma 4 31B", "18.32GB"),
    ] {
        if let Some(entry) = entries.iter_mut().find(|entry| entry.model == reference) {
            // Catalog metadata may describe layers ("42 layers") instead of bytes.
            if !entry.size.as_deref().is_some_and(byte_size) {
                entry.size = Some(size.into());
                entry.name = name.into();
                entry.fit = fit(Some(size), bytes as f64 / 1e9);
            }
        } else {
            entries.push(Entry {
                model: reference.into(),
                name: name.into(),
                size: Some(size.into()),
                description: None,
                installed: installed(reference),
                curated: false,
                fit: fit(Some(size), bytes as f64 / 1e9),
            });
        }
    }
    let recommended = Some(recommendation.to_owned());
    entries.sort_by(|a, b| {
        (Some(&b.model) == recommended.as_ref())
            .cmp(&(Some(&a.model) == recommended.as_ref()))
            .then(b.curated.cmp(&a.curated))
            .then(fit_rank(a.fit).cmp(&fit_rank(b.fit)))
            .then(a.name.cmp(&b.name))
    });
    Catalog {
        gpu_name,
        vram_display: vram::format_rated_capacity(bytes),
        recommended,
        entries,
        hosting: None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[cfg(all(target_os = "macos", target_arch = "aarch64"))]
    #[test]
    fn macos_hosting_survey_reports_physical_memory() {
        // Exercise the OS boundary: synthetic surveys hid the SDK's missing RAM field.
        let survey = hosting_survey();
        assert!(survey.is_soc);
        assert!(survey.system_ram_bytes.is_some_and(|bytes| bytes > 0));
        let result = hosting(&survey, &[]);
        assert_ne!(result.memory_display, "unknown");
        assert!(result.max_vram_gb > 0);
    }

    #[test]
    fn first_run_uses_physical_memory_and_excludes_unknown_or_oversized_models() {
        let mut catalog = build(
            None,
            0,
            vec![
                model("unsloth/gemma-4-small", "Small", "2GB"),
                model("unsloth/gemma-4-medium", "Medium", "5GB"),
                model("unsloth/gemma-4-large", "Large", "8GB"),
                model("unsloth/gemma-4-largest", "Largest", "11GB"),
                model("unsloth/gemma-4-unknown", "Unknown", "unknown"),
            ],
            |_| false,
        );
        catalog.entries.retain(|entry| {
            entry.model.starts_with("unsloth/gemma-4-") && !entry.model.contains("GGUF")
        });
        for (memory, budget, expected) in [
            (8, 2, None),
            (16, 4, Some("Small")),
            (32, 8, Some("Medium")),
            (48, 12, Some("Large")),
            (64, 16, Some("Largest")),
            (128, 32, Some("Largest")),
        ] {
            let survey = hardware::HardwareSurvey {
                is_soc: true,
                system_ram_bytes: Some(memory * 1024 * 1024 * 1024),
                vram_bytes: 6 * 1024 * 1024 * 1024,
                ..Default::default()
            };
            let result = hosting(&survey, &catalog.entries);
            assert_eq!(result.max_vram_gb, budget);
            assert_eq!(
                catalog
                    .entries
                    .iter()
                    .find(|entry| Some(&entry.model) == result.model.as_ref())
                    .map(|entry| entry.name.as_str()),
                expected
            );
        }
        assert!(
            hosting(&hardware::HardwareSurvey::default(), &catalog.entries)
                .model
                .is_none()
        );
        let discrete = hardware::HardwareSurvey {
            system_ram_bytes: Some(128 * 1024 * 1024 * 1024),
            gpus: vec![hardware::GpuFacts {
                vram_bytes: 8 * 1024 * 1024 * 1024,
                ..Default::default()
            }],
            ..Default::default()
        };
        assert!(hosting(&discrete, &catalog.entries).model.is_none());
    }
    #[test]
    fn auto_uses_the_hosting_policy_and_falls_back_to_the_legacy_ladder() {
        let catalog = build(None, 0, vec![], |_| false);
        let unified = |gb: u64| hardware::HardwareSurvey {
            is_soc: true,
            system_ram_bytes: Some(gb * 1024 * 1024 * 1024),
            vram_bytes: gb * 1024 * 1024 * 1024 * 3 / 4,
            ..Default::default()
        };
        // Seeded Gemma 4 sizes alone choose the model, with the quarter budget as the cap.
        for (gb, model, budget) in [
            (16, GEMMA_TINY, 4),
            (24, GEMMA_TINY, 6),
            (256, GEMMA_DENSE, 64),
        ] {
            assert_eq!(
                auto_choice(&unified(gb), &catalog.entries),
                AutoChoice {
                    model: model.into(),
                    max_vram_gb: Some(budget),
                }
            );
        }
        assert_eq!(
            auto_choice(&unified(64), &catalog.entries),
            AutoChoice {
                model: CURATED_SMALL.into(),
                max_vram_gb: Some(16),
            }
        );
        assert_eq!(
            auto_choice(&unified(128), &catalog.entries),
            AutoChoice {
                model: GEMMA_MOE.into(),
                max_vram_gb: Some(32),
            }
        );
        assert_eq!(
            auto_choice(&unified(32), &catalog.entries),
            AutoChoice {
                model: CURATED_SMALL.into(),
                max_vram_gb: Some(8),
            }
        );
        // Below the hosting floor, Auto keeps the previous uncapped ladder.
        assert_eq!(
            auto_choice(&unified(8), &catalog.entries),
            AutoChoice {
                model: CURATED_SMALL.into(),
                max_vram_gb: None,
            }
        );
    }
    #[test]
    fn seeded_gemma_sizes_replace_layer_counts_but_keep_valid_sizes() {
        for (label, expected) in [
            (Some("42 layers"), "4.98GB"),
            (Some("0GB"), "4.98GB"),
            (Some("unknown"), "4.98GB"),
            (None, "4.98GB"),
            (Some("5.10GB"), "5.10GB"),
        ] {
            let mut entry = model("unsloth/gemma-4-E4B-it-GGUF", "Gemma 4 E4B", "");
            entry.size = label.map(Into::into);
            let catalog = build(None, 0, vec![entry], |_| false);
            let found: Vec<_> = catalog
                .entries
                .iter()
                .filter(|e| e.model == CURATED_SMALL)
                .collect();
            assert_eq!(found.len(), 1, "{label:?}");
            let found = found[0];
            assert_eq!(found.size.as_deref(), Some(expected), "{label:?}");
        }
        // A 32 GB unified machine picks E4B even when metadata said "42 layers".
        let catalog = build(
            None,
            0,
            vec![model(
                "unsloth/gemma-4-E4B-it-GGUF",
                "Gemma 4 E4B",
                "42 layers",
            )],
            |_| false,
        );
        let survey = hardware::HardwareSurvey {
            is_soc: true,
            system_ram_bytes: Some(32 * 1024 * 1024 * 1024),
            ..Default::default()
        };
        assert_eq!(
            auto_choice(&survey, &catalog.entries).model,
            CURATED_SMALL.to_string()
        );
    }
    #[test]
    fn discrete_gpu_fallback_rates_the_card_not_the_survey_aggregate() {
        // Windows report: a 12 GB card whose survey aggregate read 32 GB fell
        // back to Qwen3.5-9B; the card's own VRAM picks Gemma 4 E4B.
        let gb = 1024 * 1024 * 1024;
        let survey = hardware::HardwareSurvey {
            vram_bytes: 32 * gb,
            system_ram_bytes: Some(32 * gb),
            gpus: vec![hardware::GpuFacts {
                vram_bytes: 12 * gb,
                ..Default::default()
            }],
            ..Default::default()
        };
        assert_eq!(device_memory_bytes(&survey), 12 * gb);
        let choice = auto_choice(&survey, &[]);
        assert_eq!(choice.model, CURATED_SMALL);
        assert_eq!(choice.max_vram_gb, None);
    }
    #[test]
    fn quantization_matches_do_not_confuse_dynamic_and_standard_files() {
        assert!(exact_quant("model-Q4_K_M.gguf", "Q4_K_M"));
        assert!(!exact_quant("model-UD-Q4_K_M.gguf", "Q4_K_M"));
        assert!(exact_quant("model-UD-Q4_K_XL.gguf", "UD-Q4_K_XL"));
        assert!(!exact_quant("model-Q4_K_M_EXTRA.gguf", "Q4_K_M"));
    }
    #[test]
    fn aliases_keep_the_donor_ingress_contract() {
        assert_eq!(
            canonical_curated_model_id("Gemma-4-E4B-it-Q4_K_M"),
            CURATED_SMALL
        );
        assert_eq!(
            canonical_curated_model_id("Qwen3.5-9B-Vision-Q4_K_M"),
            CURATED_MEDIUM
        );
        assert_eq!(
            canonical_curated_model_id("Qwen3.8-27B-Q4_K_M"),
            "unsloth/Qwen3.8-27B-GGUF:Q4_K_M"
        );
        assert_eq!(
            canonical_curated_model_id("gemma-4-26B-A4B-it-UD-Q4_K_M"),
            "unsloth/gemma-4-26B-A4B-it-GGUF:UD-Q4_K_M"
        );
        assert_eq!(canonical_curated_model_id(" custom-model "), "custom-model");
    }
    #[test]
    fn fit_preserves_donor_thresholds_and_unknown_is_not_a_fit() {
        assert_eq!(fit(Some("10GB"), 20.0), "comfortable");
        assert_eq!(fit(Some("10GB"), 12.0), "tight");
        assert_eq!(fit(Some("10GB"), 10.0), "tradeoff");
        assert_eq!(fit(Some("10GB"), 8.0), "too_large");
        assert_eq!(fit(None, 96.0), "unknown");
        assert_eq!(fit(Some("10GB"), 0.0), "unknown");
    }
    fn model(repo: &str, name: &str, size: &str) -> RemoteCatalogModel {
        RemoteCatalogModel {
            repo: repo.into(),
            name: name.into(),
            file: "weights-Q4_K_M.gguf".into(),
            source_file: "weights-Q4_K_M.gguf".into(),
            revision: None,
            size: Some(size.into()),
            description: None,
            draft: None,
            extra_files: vec![],
            mmproj: None,
        }
    }
    #[test]
    fn ladder_is_catalog_backed_and_keeps_exact_ids_installation_and_draft_policy() {
        let mut large = model("unsloth/Qwen3.8-27B-GGUF", "large", "17GB");
        large.source_file = "weights-UD-Q4_K_M.gguf".into();
        large.file = large.source_file.clone();
        large.draft = Some("draft".into());
        let models = vec![
            large,
            model("unsloth/Qwen3.5-9B-GGUF", "medium", "6GB"),
            model("unsloth/gemma-4-E4B-it-GGUF", "small", "3GB"),
            model("fixture/draft", "draft", "1GB"),
        ];
        for (bytes, recommended) in [
            (24_000_000_000, CURATED_SMALL),
            (32_000_000_000, CURATED_MEDIUM),
            (64_000_000_000, CURATED_LARGE),
            (96_000_000_000, CURATED_LARGE),
        ] {
            let catalog = build(None, bytes, models.clone(), |m| m == CURATED_SMALL);
            assert_eq!(catalog.recommended.as_deref(), Some(recommended));
            assert_eq!(catalog.entries[0].model, recommended);
            // The three-rung ladder plus the seeded E2B, 26B-A4B and 31B.
            assert_eq!(catalog.entries.len(), 6);
            assert!(
                catalog
                    .entries
                    .iter()
                    .find(|e| e.model == CURATED_SMALL)
                    .unwrap()
                    .installed
            );
        }
        assert_eq!(
            build(None, 0, vec![], |_| false).recommended.as_deref(),
            Some(CURATED_SMALL)
        );
    }
    #[test]
    fn missing_layer_catalog_entry_does_not_change_the_gguf_ladder() {
        let catalog = build(
            None,
            128_000_000_000,
            vec![{
                let mut xl = model("unsloth/Qwen3.8-27B-GGUF", "large XL", "17GB");
                xl.source_file = "Qwen3.8-27B-UD-Q4_K_XL.gguf".into();
                xl.file = xl.source_file.clone();
                xl
            }],
            |reference| reference == CURATED_LARGE,
        );
        assert_eq!(catalog.recommended.as_deref(), Some(CURATED_LARGE));
        let recommended = &catalog.entries[0];
        assert_eq!(recommended.model, "unsloth/Qwen3.8-27B-GGUF:UD-Q4_K_M");
        assert!(recommended.installed);
        assert!(recommended.size.is_none());
        assert_eq!(recommended.fit, "unknown");
    }
}

#[cfg(test)]
mod auto_tests {
    use super::*;

    #[test]
    fn installed_answers_come_from_one_scan_and_keep_the_legacy_aliases() {
        let installed = installed_matcher(vec![
            "Gemma-4-E4B-it-Q4_K_M".to_string(),
            "unsloth/Qwen3.5-9B-GGUF:Q4_K_M".to_string(),
        ]);

        assert!(installed(CURATED_SMALL));
        assert!(installed("unsloth/Qwen3.5-9B-GGUF:Q4_K_M"));
        assert!(!installed(CURATED_LARGE));
        assert!(!installed("unsloth/gemma-4-26B-A4B-it-GGUF:UD-Q4_K_M"));
    }

    #[test]
    fn auto_follows_the_hardware_ladder_without_catalog_or_cache_fallback() {
        assert_eq!(
            recommendation_for_memory(16 * 1024 * 1024 * 1024),
            CURATED_SMALL
        );
        assert_eq!(
            recommendation_for_memory(32 * 1024 * 1024 * 1024),
            CURATED_MEDIUM
        );
        assert_eq!(
            recommendation_for_memory(128 * 1024 * 1024 * 1024),
            CURATED_LARGE
        );
    }
}
