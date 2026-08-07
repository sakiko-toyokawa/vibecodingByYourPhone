# assembly-004-proposal-effects

Implement consumption of published/canary improvement proposals in `loop/assembly`.

Requirements:

- `memory_packet_template_proposal`: a published proposal applies to all loops unless `payload.canary_loops` limits it. Its `payload.memory_packet_template` is injected into the prompt. A canary proposal only applies when the loop is in `canary_loops` or the proposal target starts with `<loop_id>.`.
- `runtime_adapter_proposal`: a published/canary `payload.adapter_policy` is carried on `RuntimeInput.adapterPolicy`; a positive `timeout_seconds` value is projected into `native_invocation.timeout_seconds`.
- `policy_profile_proposal`: a published/canary override of the policy profile name is resolved through the registry to real rule differences. It only has an effect when the card already has a non-manual policy block.
- Draft / shadow / approved / rolled_back / rejected proposals are not consumed by the assembly.
- When the newest published version in a slot is rolled back, the next newest published version in that slot takes effect.
- `RuntimeInput.appliedProposals` lists the ids of proposals that actually affected the bundle.
