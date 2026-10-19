# Friction log

Friction log for the Build, Ship, Shape: Amazon Developer Hackathon submission (Alexa+ track).

1. Task: choose SDK packages for an MCP Apps server. Steps: read the MCP Apps docs, which install @modelcontextprotocol/server 2.x; npm's @modelcontextprotocol/sdk is 1.32.1. Expected: one recommended path. Actual: two package lines. Severity: low. Workaround: used sdk 1.32.1 (protocol 2025-11-25) and implemented the ui:// resource and _meta.ui by hand. Suggestion: state which SDK line Alexa+ expects.

2. Task: return structuredContent with an extra field used only by the card. Expected: ignored. Actual: client error "Structured content does not match the tool's output schema: data must NOT have additional properties". Severity: medium. Workaround: added the field to outputSchema. Suggestion: name the extra property in the error.

3. Task: test the server as Alexa+ would call it. Expected: a test harness. Actual: none available to us. Severity: high. Workaround: built a simulated host. Suggestion: publish a reference Alexa+ MCP test client. All three were encountered during this build.
