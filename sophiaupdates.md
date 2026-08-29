## Plan: Shared-Source Embeddings RAG

Implement retrieval-augmented generation by inserting retrieval in the server-side run path while keeping the runner abstraction intact. The design is a phased rollout that covers three sources from the start: the agent workspace, a shared resources root usable by multiple agents, and semantic retrieval over old chat messages. Retrieve top matches in `AgentService.sendMessage`, merge them into a bounded prompt context, and pass the enriched prompt to the runner.

**Phases**
1. Foundation and access model. Define the private workspace boundary, introduce a separate shared resources root beside agent workspaces, and lock in semantic retrieval over old chat messages as an agent-scoped corpus. Shared content must be readable by authorized agents and must not be archived with any single agent.
2. Core retrieval plumbing. Add the embeddings indexer and prompt assembler so private workspace files, shared resources, and old messages can all be chunked, embedded, retrieved, and merged with provenance preserved. Add an explicit retrieval status so callers can tell when there is no useful context.
3. Resource ingestion and sharing. Add document upload handling for private agent workspaces, then support publishing or copying resources into the shared root when they should be usable by multiple agents. Trigger reindexing on upload, publish, update, and deletion.
4. Lifecycle and persistence. Extend storage only as needed for shared-resource metadata and index metadata, add any schema/version support, and wire agent or shared-resource lifecycle events to reindex or invalidate embeddings.
5. UI and inspection. Expose upload management and shared-resource management in the API/UI only if needed, and add retrieval visibility and confidence indicators for debugging if the workflow requires it.
6. Test coverage. Cover retrieval enrichment, semantic chat-history inclusion, shared-resource visibility across agents, the rule that deleting one agent does not delete shared content, and the no-context confidence state.

**Steps**
1. Define the corpus boundaries and trust rules. Use the agent workspace for private files, keep shared resources in a separate root outside that tree, and treat old chat messages as an agent-scoped semantic source.
2. Add a shared resource manager. Create server-side plumbing to create, list, update, publish, and delete shared documents in a dedicated root, with their own metadata and lifecycle.
3. Add ingestion for workspace uploads and shared publishing. Store uploaded documents in the agent workspace first, then allow selected documents to be copied or published into the shared root for reuse by multiple agents.
4. Add a retrieval/index component on the server side. Chunk workspace files, shared resources, and old messages, compute embeddings, and return top-k matches for a prompt, using separate namespaces for private workspace, shared corpus, and chat history.
5. Extend persistence only as needed. If indexes are rebuilt on demand, store timestamps and fingerprints; if indexes are persisted, add schema/version support in the JSON store. Keep shared-resource records separate from agent records so access can be enforced cleanly.
6. Hook retrieval into the execution path. In `AgentService.sendMessage`, fetch private workspace chunks, shared-resource chunks, and semantic chat-history context before calling `executeRun`, then assemble the prompt wrapper and preserve the original user prompt in run history.
7. Add reindexing lifecycle support. Rebuild or refresh the index when an agent is created, updated, deleted, when uploads change, and when shared resources change; optionally expose a manual reindex endpoint or service method.
8. Expose retrieval visibility in the API/UI only if needed. Start server-first; add shared-resource management and retrieval inspection in the web app only if the workflow needs it.
9. Add tests for orchestration and access boundaries. Cover retrieval insertion in `AgentService`, upload-driven reindex behavior, semantic chat-history inclusion rules, shared-resource visibility across agents, and the rule that deleting one agent does not delete shared resources.

**Relevant files**
- `/Users/sophia/Documents/GitHub/renamepls/apps/server/src/agent-service.ts` — merge private workspace, shared resource, and chat-history context before `executeRun`, and preserve run/message state transitions.
- `/Users/sophia/Documents/GitHub/renamepls/apps/server/src/workspace.ts` — keep private workspace ownership, and add adjacent support for a separate shared root if lifecycle helpers are needed.
- `/Users/sophia/Documents/GitHub/renamepls/apps/server/src/store.ts` — extend for shared-resource metadata, index metadata, and any migration needed for cross-agent access control.
- `/Users/sophia/Documents/GitHub/renamepls/apps/server/src/types.ts` — add types for retrieval results, shared-resource records, index metadata, confidence status, and prompt context.
- `/Users/sophia/Documents/GitHub/renamepls/apps/web/src/App.tsx` — add upload file inputs and retrieval confidence display in the agent view.
- `/Users/sophia/Documents/GitHub/renamepls/apps/web/src/api.ts` — extend the client contract for retrieval status in send-message responses.
- `/Users/sophia/Documents/GitHub/renamepls/apps/server/src/app.ts` — add routes for uploads, shared-resource management, and manual reindex if they are exposed through HTTP.
- `/Users/sophia/Documents/GitHub/renamepls/apps/server/src/config.ts` — add configuration for the shared root path and any indexing limits or feature flags.
- `/Users/sophia/Documents/GitHub/renamepls/apps/server/src/agent-service.test.ts` — primary orchestration tests for retrieval enrichment, upload reindexing, chat-history usage, confidence output, and shared-resource access.
- `/Users/sophia/Documents/GitHub/renamepls/apps/server/src/store.test.ts` — persistence tests if shared-resource metadata or index metadata is stored.
- `/Users/sophia/Documents/GitHub/renamepls/apps/server/src/container-codex-runner.test.ts` — verify the shared root is not accidentally collapsed into the private workspace boundary.
- `/Users/sophia/Documents/GitHub/renamepls/apps/web/src/App.tsx` — optional UI changes for upload management, shared-resource management, and retrieval inspection.

**Verification**
1. Add a focused backend test proving the runner receives enriched prompt context while the stored user message remains unchanged.
2. Add a test that uploaded documents are indexed or reindexed and can be retrieved for a prompt.
3. Add a test that semantic retrieval over older chat messages returns relevant context within the token budget.
4. Add a test that a shared resource is visible to multiple authorized agents and survives deletion of one agent.
5. Add a test for the no-context confidence state when retrieval returns nothing relevant.
6. Run the narrow server test file(s) covering the touched slice, then run the server typecheck/test command for the workspace.
7. If UI changes are added, run the web test/build or the narrowest available frontend check.

**Decisions**
- Semantic retrieval over old messages is part of the base design, not an optional later enhancement.
- Shared resources live in a separate root beside agent workspaces, not inside them.
- Uploaded documents belong to the owning agent workspace first and may be promoted into the shared root when collaboration is intended.
- The runner contract should stay stable unless there is a strong reason to surface retrieval metadata downstream.
- This plan excludes production-scale vector infrastructure unless the project needs larger corpora or multi-tenant access controls.

**Further Considerations**
1. For shared resources, should publication be copy-based or reference-based? Copy-based is simpler; reference-based avoids duplication.
2. For chat history, should semantic retrieval include only user messages, or both user and assistant messages? Including both is more context-rich but may add noise.
3. Should the shared resource root have its own UI and permissions model from day one, or start as a server-only feature with a later UI layer?

## Update: 2026-08-30 RAG Context Visibility Questions

User asked how the model determines when no context is available, whether the app can explicitly tell users there is no retrieved context, whether PDF/actual file uploads can replace pasted text, and whether a confidence indicator makes sense.

Current implementation notes:
- `apps/server/src/rag-service.ts` builds context from three sources: agent workspace files, shared resource files, and older messages for the same agent.
- Retrieval currently returns `{ prompt, matches }`; when there are no candidate chunks at all it returns the original prompt and an empty `matches` array.
- There is no score threshold yet, so if candidates exist, the service takes the top `ragTopK` matches even when similarity is weak. That means the app cannot reliably distinguish "good context found" from "only low-quality context found" today.
- Retrieval metadata is not exposed through `/api/agents/:id/messages`; `AgentService.sendMessage` uses the augmented prompt internally but returns only `{ run, message }`.
- Upload endpoints exist for private agent uploads and shared resources, but they accept `{ name, content }` as JSON strings. The server writes UTF-8 text and RAG skips binary/non-text files. Native PDF or multipart file upload parsing is not implemented yet.

Recommended next implementation:
- Add `RagContext.status` such as `no_sources`, `no_relevant_context`, and `context_found`, plus a conservative score threshold.
- Add retrieval summary fields to `AgentRun` or the send-message response, for example `retrieval: { status, confidence, matchCount, topScore, sources }`.
- Treat confidence as a retrieval-grounding/debug signal, not as a guarantee that the model's final answer is correct.
- Add real file upload support using multipart handling and parsers for PDF/DOCX/etc.; convert extracted text into the existing workspace/shared resource corpus.

## Plan: Uploaded Document Context + Match Strength

Build a more capable context-ingestion path so users can upload markdown and PDF files, and add a retrieval-strength indicator so the UI can show when context looks weak, missing, or strong.

**Goals**
1. Let users upload documents instead of pasting everything manually.
2. Support `md`/`markdown` content and PDF extraction from uploaded files.
3. Expose a context match strength indicator in the API and UI.

**Phases**
1. Ingestion support.
   - Add a real file-upload path for agent uploads and shared resources.
   - Keep plain text and Markdown working.
   - Add PDF text extraction so PDF uploads become searchable context.
2. Normalization and indexing.
   - Convert uploaded files into text chunks before retrieval.
   - Preserve source metadata such as filename, file type, and origin.
   - Reindex when uploads are added, replaced, or deleted.
3. Match strength.
   - Add retrieval status values such as `no_context`, `weak`, `moderate`, and `strong`.
   - Use similarity thresholds and top-score comparison to classify the result.
   - Return a compact retrieval summary alongside the run result.
4. UI surfacing.
   - Show a visible context-strength indicator on message send or run result.
   - Add enough detail for debugging without overwhelming the user.
5. Validation.
   - Test Markdown upload retrieval.
   - Test PDF upload extraction and retrieval.
   - Test no-context and weak-context indicator states.

**Suggested implementation order**
1. Add upload handling for real files.
2. Add PDF extraction and keep Markdown/text as-is.
3. Extend `RagContext` and send-message responses with retrieval status.
4. Add UI display for the indicator.
5. Cover the new behavior with backend and frontend tests.

**Open decisions**
1. Should PDF uploads be stored as extracted text only, or should the original binary be preserved too?
PDF uploads can be stored as both, and allow users to view it through the UI
2. Should match strength be based only on the best score, or also on score spread across top results?
Top results
3. Should the UI show a simple label only, or a label plus numeric score for debugging?
Label and numeric score
