# Trigger matrix

Use this matrix only to decide whether documentation catch-up owns the current task.

| Request or state | Use this skill | Route |
| --- | --- | --- |
| "The tested feature is ready for another owner; update its maintainer contract." | Yes | Semantic packet, then maintainer view |
| "This experimental flag is about to become default-on; update both locales." | Yes | Semantic packet, bilingual user views, structural check |
| "Resolve the documented debt for the session export contract." | Yes | Reconstruct candidate evidence, then semantic packet |
| "Here is an approved semantic packet; apply these exact mirror and nav edits." | Yes | Mechanical packet; finite execution may be delegated |
| "Implement the feature, and do not stop for docs yet." | No | Implementation remains active; classify at a coherent candidate |
| "Where does Kiki store sessions?" | No | `kiki-docs` read-only retrieval |
| "Translate this approved English guide into Chinese." | No | `translate-docs` |
| "Sync the changelog after release." | No | `sync-changelog` |
| "Draft a new public behavior with no implementation or tests." | No | Product/design decision or implementation must establish the contract first |

## Hard case

If code is complete but the relevant test only snapshots nearby output, the candidate is not evidence-ready for a new behavioral claim. Name the missing claim-matched assertion and stop. A broad green suite does not substitute for an oracle tied to the documented behavior.

## Success check

The skill has finished only when the due audience views and exact generated projections are current, the semantic packet cites behavior evidence, focused checks pass, and any deferral names both owner and target boundary. Passing structural checks alone is insufficient.
