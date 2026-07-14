# Runtime Collection Design

The feature is default-off. Only exact `CAUSAL_EXPERIENCE_COLLECTION_MODE=shadow` enables append-only collection, and only for runtime instances 3101 and 3102. Port or identity 3103 is hard-blocked independently of any other collection flag. Off, unknown, and 3103 modes perform no collector filesystem I/O.

Collection failures are caught and never change admission, order sizing, resolver outcomes, stops, positions, allocation, CORTEX beta, or kill rails.
