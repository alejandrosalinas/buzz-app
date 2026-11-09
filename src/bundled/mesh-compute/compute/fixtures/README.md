# SDK status fixture

`sdk-status-ready.json` is an unchanged field subset of a captured console `/api/status` response, read through the SDK status surface. Source: workspace `RESEARCH/evidence-split-lab-fb58/m5-status.json`; source SHA-256: `728f60f4ab33c63a55043829a5a7e512fdf0d3106bfa3ced1ccf2cbcfabcab27`.

Retained: version, models, hosted_models, serving_models, runtime.models. All other runtime fields were removed too. Removed all other fields (including node identity, endpoint tokens, peer inventory and machine metadata). No new live run was performed. This is historical runtime-schema evidence, not verification against the current SDK pin.
