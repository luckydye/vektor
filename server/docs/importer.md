# Vektor Importer

Import into Vektor as a one-shot create operation. Do not create documents until every asset is uploaded and every document body has already been rewritten and validated.

## Hard Rules

*   Use the `vektor` CLI for Vektor writes and uploads. Required env vars are assumed to be set unless the user says otherwise.
    
*   Never use document update as a retry strategy. `vektor write <docId> ...` is an update path and must not be used for imports.
    
*   Never create a document before all referenced assets have been uploaded and all document content has been rewritten to Vektor upload URLs.
    
*   Never attach assets to documents as a substitute for replacing markdown references.
    
*   If any target document already exists, abort before creating anything. Ask the user how to proceed instead of updating, deleting, or suffixing your way around it.
    
*   Preserve `created` and `modified` metadata with `vektor write <file> --created <date> --modified <date>`.
    
*   Exclusions requested by the user are absolute. Verify excluded directories are absent from the manifest.
    

## Workflow

1.  Build an import manifest.
    
    *   Discover documents, categories, source paths, titles, desired slugs, created dates, modified dates, and local asset references.
        
    *   Parse metadata from the source format. If required dates are missing, stop.
        
    *   Detect duplicate desired slugs before calling Vektor.
        
    *   Query `vektor ls --limit 10000`; if any target document slug already exists, stop before uploading or writing documents.
        
2.  Upload assets first.
    
    *   Upload every file that may be referenced, or at minimum every referenced file, with `vektor upload <file> --filename <name> --content-type <mime> --json`.
        
    *   Store a source-path to uploaded-URL map in a local manifest/cache.
        
    *   Upload-only resume is allowed because no documents exist yet. Once document creation begins, retrying must not update existing documents.
        
3.  Rewrite document bodies in staging.
    
    *   Replace all local asset links such as `../files/name.png`, `files/name.png`, and `/files/name.png` with uploaded Vektor URLs.
        
    *   Remove image size artifacts like `{w=928 h=674}` unless the target renderer supports setting actual width and height. If preserving dimensions, emit valid target-supported markup; do not leave raw artifacts after images.
        
    *   Strip export-only frontmatter unless Vektor should store it as visible content.
        
    *   For empty documents, use an explicit minimal body accepted by the API, such as an HTML comment.
        
4.  Validate the staged import before writing documents.
    
    *   Assert every referenced local file has an uploaded URL.
        
    *   Assert staged documents contain no local asset references.
        
    *   Assert staged documents contain no raw image-size artifacts unless intentionally converted to real dimensions.
        
    *   Assert categories exist or can be created.
        
    *   Assert Vektor still has no target documents.
        
5.  Create documents once.
    
    *   Create categories first if needed.
        
    *   Use only create form: `vektor write <staged-file> --slug <slug> --title <title> --category <category-slug> --created <date> --modified <date>`.
        
    *   Record returned document IDs and returned slugs. Vektor may return a suffix if it reserves deleted slugs; report this, but do not update the document.
        
    *   If creation fails after any document was created, stop. Do not resume by updating. Report exactly what was created and what remains.
        
6.  Verify.
    
    *   Count documents and uploads with `vektor ls --limit 10000`.
        
    *   Spot-check documents with `vektor cat <docId>` for uploaded asset URLs and absence of local references/artifacts.
        
    *   If possible, inspect API metadata for preserved `createdAt` and `updatedAt`.
        

## Implementation Notes

*   Keep the importer language-agnostic: shell, Ruby, Python, Node, Go, or another available tool is fine. Choose based on the repo/environment and available standard libraries.
    
*   Prefer structured parsers for source metadata when available. If using simple parsing, fail on unexpected structure.
    
*   Use deterministic manifests and fail-fast assertions. Do not silently skip missing files, malformed dates, duplicate slugs, unsupported MIME types, or upload failures.
    
*   Do not install npm packages or other dependencies unless explicitly allowed by the user.