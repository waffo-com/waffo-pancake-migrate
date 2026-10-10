# Dodo API fixture provenance

`dodo-test-products.json` contains selected fields from real GET /products/{id}
responses fetched from Dodo test mode on 2026-10-10 for the three requested
SpriteGen products. Values were not synthesized from expected configuration.
Only fields consumed by the mapper were retained. Authentication, request headers,
business/brand IDs and timestamps are excluded. No API keys are stored here.

The recurring interval enum is capitalized (`Month`), as defined by the official
TypeScript SDK's `TimeInterval` type. These fixtures guard against incorrect
lowercase assumptions. Live tests do not run as part of `npm test`.
