# Decision To Opportunity Link

The allocator and variant-matrix paper-order constructors stamp a `CausalIdentity` only when `CAUSAL_EXPERIENCE_COLLECTION_MODE=shadow` on 3101 or 3102. After the existing paper store accepts the order, the collector appends an immutable decision snapshot and an opportunity-open event with the same direct `decisionId`.

Legacy paper orders remain without an identity and are not repaired or made eligible.
