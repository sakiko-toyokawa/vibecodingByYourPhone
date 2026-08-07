# assembly-002-policy-projection-resolution

Resolve `loop.policy.profile` into a full `PolicyProfile` and project it into the `RuntimeInputBundle`.

Requirements:

- Named profiles are looked up in `loop/policy/profiles.ts` and produce real rule differences, not just labels.
- `loop_bypass` / `github_issue_local_fix` keep the default risk rules and full bypass scope.
- `loop_strict_review` sets medium risk to `review_or_policy`, high risk to `human_required`, and disables local commands in the bypass scope.
- Unknown profile names fall back to the default risk rules and default bypass scope.
- `card.loop.human_gate.required_for` is merged into `hard_gates`.
- `approval_mode: "manual"` still resolves a profile (it degrades to read-only runtime behavior).
- When the card has no policy block, `resolvePolicyProfile` returns `null`.
