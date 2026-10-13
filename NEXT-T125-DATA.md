# For the next iteration (T-125 data shapes are live, #parachute 10-12)
The companion panel should read real data:
- One sentence: node `metadata.stands` (+ `stands_at`, `stands_by`); all 41 nodes are seeded (the scratch copy has them too).
- Running: tag `run`: `node, task, state (running|done|blocked|decision|failed), room, worker, started_at, ended_at, summary`.
  Note the field change from 0.1.44's ledger (`started`/`updated`/`by`/queued|stalled): map both.
- Drafts: tag `draft`: `node, for, state`.
- Decisions: tag `decision`: `options[]`, `state open|decided`, `decided, decided_at, decided_by`. One-tap decide =
  PATCH `state_transition {field:'state', from:'open', to:'decided'}` + metadata `{decided, decided_at, decided_by}`.
  A decision with options belongs in the panel's needs-you items as option buttons.
