# Importer defects

Fixed offline: decision-log route snapshots were previously absent from the Experience Engine; they are now imported with deterministic IDs, raw feature provenance, and versioned schema metadata. Paper source candidate IDs are now preserved as explicit attempted links.

| Field gap | Classification | Action |
|---|---|---|
| decision-log pre-open route features | PRESENT_BUT_NOT_IMPORTED | imported by exact adapter |
| paper sourceCandidateId | PRESENT_UNDER_DIFFERENT_SCHEMA | preserved as explicit join attempt |
| route-derived numeric features at decision time | DERIVABLE_CAUSALLY | normalized only from same decision record |
| aligned-shadow decision ID and immutable feature snapshot | FORWARD_COLLECTION_REQUIRED | do not reconstruct |
| row-level historical replay decision/outcome export | PERMANENTLY_UNAVAILABLE in current checkout | do not infer from aggregates |
| paper createdAt as decision time | UNSAFE_TO_RECONSTRUCT | rejected because it is after market open |

No original journal was rewritten.
