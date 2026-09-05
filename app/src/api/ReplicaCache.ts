import type {
  CategoriesListResponse,
  Category,
  Comment,
  DocumentWithProperties,
  ExtensionInfo,
  ExtensionManifestError,
  Space,
} from "./ApiClient.ts";
import {
  ReplicaDb,
  type ReplicaOperation,
  type ReplicaRecord,
  type ReplicaWrite,
  replicaStores,
} from "./ReplicaDb.ts";

/**
 * Rows that do not live inside a space — currently only the list of spaces
 * itself. Every key path starts with a space id, so they need a stable one.
 */
const ROOT_SPACE = "";

/**
 * Names of the ordered id lists in the `collection` store.
 *
 * A list endpoint's answer is stored as the ids it returned, in its order.
 * Reading a list means walking these ids, so a row the server dropped stops
 * being listed as soon as the list is refreshed, and a row we happen to hold
 * for another reason never leaks into a list it was not part of.
 */
const collections = {
  spaces: "spaces",
  documents: "documents",
  categories: "categories",
  extensions: "extensions",
  /**
   * The category grouping — descendant expansion included — is a server rule.
   * Storing its answer per slug keeps the client from reimplementing it, and
   * costs one row per category instead of one per set of expanded categories.
   */
  categoryDocuments: (slug: string) => `documents:category:${slug}`,
  comments: (documentId: string) => `comments:${documentId}`,
} as const;

interface CollectionRecord extends ReplicaRecord {
  name: string;
  ids: string[];
  /** List-level fields that belong to the response rather than to any row. */
  meta?: {
    hasHiddenCategories?: boolean;
    errors?: ExtensionManifestError[];
  };
}

/** Spaces are listed together, so their rows share the root scope. */
interface SpaceRecord extends ReplicaRecord, Space {}

/**
 * The `document` table's columns.
 *
 * `content` is optional because a listing does not return it, so a row knows
 * the difference between "empty document" and "only ever seen in a list" — the
 * latter is not a cache hit for anything that needs the body.
 */
type DocumentFields = Omit<DocumentWithProperties, "properties" | "content"> & {
  content?: string;
};

interface DocumentRecord extends ReplicaRecord, DocumentFields {}

interface PropertyRecord extends ReplicaRecord {
  documentId: string;
  key: string;
  value: string | string[];
}

interface CategoryRecord extends ReplicaRecord, Category {}
interface CommentRecord extends ReplicaRecord, Comment {}
interface ExtensionRecord extends ReplicaRecord, ExtensionInfo {}

/**
 * A row minus its storage bookkeeping, which is exactly the entity the API
 * returned. Rows carry an index signature so that any table can be stored, so
 * the result has to be named rather than derived from the row type.
 */
function toEntity<T>(record: ReplicaRecord): T {
  const { spaceId: _spaceId, operationId: _operationId, ...entity } = record;
  return entity as T;
}

function byId<T extends { id: string }>(records: T[]): Map<string, T> {
  return new Map(records.map((record) => [record.id, record]));
}

/** Rows in the order the server listed them, skipping ids we no longer hold. */
function inCollectionOrder<T extends { id: string }>(
  collection: CollectionRecord | null,
  records: T[],
): T[] | undefined {
  if (!collection) return undefined;
  const lookup = byId(records);
  return collection.ids
    .map((id) => lookup.get(id))
    .filter((record): record is T => record !== undefined);
}

/**
 * The cached copy of a space's data, shaped like the server's tables.
 *
 * Callers hand it API results and ask it questions; it owns the translation in
 * both directions. Nothing above it knows that a document's properties are
 * stored separately, or that a list is an id order rather than a payload.
 */
export class ReplicaCache {
  private readonly db = new ReplicaDb();

  setScope(scope: string | null | undefined): void {
    this.db.setScope(scope);
  }

  // --------------------------------------------------------------- spaces

  async readSpaces(): Promise<Space[] | undefined> {
    const [collection, records] = await Promise.all([
      this.collection(ROOT_SPACE, collections.spaces),
      this.db.getSpace<SpaceRecord>(replicaStores.space, ROOT_SPACE),
    ]);
    return inCollectionOrder(
      collection,
      records.map((record) => toEntity<Space>(record)),
    );
  }

  subscribeSpaces(callback: (spaces: Space[] | undefined) => void): () => void {
    return this.db.subscribe(
      [replicaStores.space, replicaStores.collection],
      null,
      () => this.readSpaces(),
      callback,
    );
  }

  async writeSpaces(spaces: Space[]): Promise<void> {
    await this.db.writeRemote([
      ...spaces.map((space) => this.spaceWrite(space)),
      this.collectionWrite(
        ROOT_SPACE,
        collections.spaces,
        spaces.map((space) => space.id),
      ),
    ]);
  }

  async writeSpace(space: Space): Promise<void> {
    await this.db.writeRemote(async () => [
      this.spaceWrite(space),
      ...(await this.appendToCollection(ROOT_SPACE, collections.spaces, space.id)),
    ]);
  }

  async patchSpace(
    spaceId: string,
    patch: Partial<Space>,
  ): Promise<ReplicaOperation | null> {
    return await this.db.writeOptimistic(async () => {
      const record = await this.db.get<SpaceRecord>(replicaStores.space, [
        ROOT_SPACE,
        spaceId,
      ]);
      return record ? [{ store: replicaStores.space, put: { ...record, ...patch } }] : [];
    });
  }

  /** Forget a space entirely: its listing entry and every row inside it. */
  async removeSpace(spaceId: string): Promise<void> {
    await this.db.writeRemote(async () => [
      ...(await this.removeFromCollection(ROOT_SPACE, collections.spaces, spaceId)),
      { store: replicaStores.space, remove: [ROOT_SPACE, spaceId] },
      ...(await this.clearSpaceWrites(spaceId)),
    ]);
  }

  // ----------------------------------------------------------- categories

  async readCategories(spaceId: string): Promise<CategoriesListResponse | undefined> {
    const [collection, records] = await Promise.all([
      this.collection(spaceId, collections.categories),
      this.db.getSpace<CategoryRecord>(replicaStores.category, spaceId),
    ]);
    const categories = inCollectionOrder(
      collection,
      records.map((record) => toEntity<Category>(record)),
    );
    if (!categories) return undefined;

    return {
      categories,
      hasHiddenCategories: collection?.meta?.hasHiddenCategories ?? false,
    };
  }

  subscribeCategories(
    spaceId: string,
    callback: (response: CategoriesListResponse | undefined) => void,
  ): () => void {
    return this.db.subscribe(
      [replicaStores.category, replicaStores.collection],
      spaceId,
      () => this.readCategories(spaceId),
      callback,
    );
  }

  async writeCategories(
    spaceId: string,
    response: CategoriesListResponse,
  ): Promise<void> {
    await this.db.writeRemote([
      ...response.categories.map((category) => ({
        store: replicaStores.category,
        put: { ...category, spaceId } satisfies CategoryRecord,
      })),
      this.collectionWrite(
        spaceId,
        collections.categories,
        response.categories.map((category) => category.id),
        { hasHiddenCategories: response.hasHiddenCategories },
      ),
    ]);
  }

  async writeCategory(spaceId: string, category: Category): Promise<void> {
    await this.db.writeRemote(async () => [
      { store: replicaStores.category, put: { ...category, spaceId } },
      ...(await this.appendToCollection(spaceId, collections.categories, category.id)),
    ]);
  }

  async patchCategory(
    spaceId: string,
    categoryId: string,
    patch: Partial<Category>,
  ): Promise<ReplicaOperation | null> {
    return await this.db.writeOptimistic(async () => {
      const record = await this.db.get<CategoryRecord>(replicaStores.category, [
        spaceId,
        categoryId,
      ]);
      return record
        ? [{ store: replicaStores.category, put: { ...record, ...patch } }]
        : [];
    });
  }

  async removeCategory(spaceId: string, categoryId: string): Promise<void> {
    await this.db.writeRemote(async () => [
      ...(await this.removeFromCollection(spaceId, collections.categories, categoryId)),
      { store: replicaStores.category, remove: [spaceId, categoryId] },
    ]);
  }

  async removeCategoryOptimistic(
    spaceId: string,
    categoryId: string,
  ): Promise<ReplicaOperation | null> {
    return await this.db.writeOptimistic(async () => [
      ...(await this.removeFromCollection(spaceId, collections.categories, categoryId)),
      { store: replicaStores.category, remove: [spaceId, categoryId] },
    ]);
  }

  // ------------------------------------------------------------ documents

  async readDocuments(spaceId: string): Promise<DocumentWithProperties[] | undefined> {
    const collection = await this.collection(spaceId, collections.documents);
    if (!collection) return undefined;
    return await this.documentsInCollection(spaceId, collection);
  }

  subscribeDocuments(
    spaceId: string,
    callback: (documents: DocumentWithProperties[] | undefined) => void,
  ): () => void {
    return this.db.subscribe(
      [replicaStores.document, replicaStores.property, replicaStores.collection],
      spaceId,
      () => this.readDocuments(spaceId),
      callback,
    );
  }

  async readDocumentsByCategories(
    spaceId: string,
    categorySlugs: string[],
  ): Promise<Record<string, DocumentWithProperties[]> | undefined> {
    const slugs = [...new Set(categorySlugs)];
    const collectionRecords = await Promise.all(
      slugs.map((slug) => this.collection(spaceId, collections.categoryDocuments(slug))),
    );
    // A partially cached answer would render a category as empty rather than
    // as unknown, so anything missing is a miss for the whole request.
    if (collectionRecords.some((collection) => collection === null)) return undefined;

    // Only these categories' own rows are fetched — one lookup shared by every
    // slug that names the same document — never the space's full document
    // table, which for a large space can be orders of magnitude bigger than
    // what any of these categories actually lists.
    const ids = [
      ...new Set(collectionRecords.flatMap((collection) => collection?.ids ?? [])),
    ];
    const documentsById = await this.documentsById(spaceId, ids);

    const result: Record<string, DocumentWithProperties[]> = {};
    slugs.forEach((slug, index) => {
      result[slug] =
        inCollectionOrder(collectionRecords[index], [...documentsById.values()]) ?? [];
    });
    return result;
  }

  subscribeDocumentsByCategories(
    spaceId: string,
    categorySlugs: string[],
    callback: (
      documentsByCategory: Record<string, DocumentWithProperties[]> | undefined,
    ) => void,
  ): () => void {
    return this.db.subscribe(
      [replicaStores.document, replicaStores.property, replicaStores.collection],
      spaceId,
      () => this.readDocumentsByCategories(spaceId, categorySlugs),
      callback,
    );
  }

  /**
   * A document addressed by id or by slug. Rows seen only in a listing have no
   * body, and are not returned here — a document view hydrated from one would
   * render as empty until the network answered.
   */
  async readDocument(
    spaceId: string,
    documentIdOrSlug: string,
  ): Promise<DocumentWithProperties | undefined> {
    const record = await this.documentRecord(spaceId, documentIdOrSlug);
    if (!record || record.content === undefined) return undefined;

    const properties = await this.db.getByIndex<PropertyRecord>(
      replicaStores.property,
      "by_document",
      [spaceId, record.id],
    );
    return this.toDocument(record, properties);
  }

  subscribeDocument(
    spaceId: string,
    documentIdOrSlug: string,
    callback: (document: DocumentWithProperties | undefined) => void,
  ): () => void {
    return this.db.subscribe(
      [replicaStores.document, replicaStores.property],
      spaceId,
      () => this.readDocument(spaceId, documentIdOrSlug),
      callback,
    );
  }

  /**
   * Store a listing as the canonical set of documents in the space.
   *
   * Callers pass an exhausted, unfiltered listing — a narrower answer says
   * nothing about the documents it left out, and pruning against it would
   * throw away rows the server still has.
   */
  async writeDocumentList(
    spaceId: string,
    documents: DocumentWithProperties[],
  ): Promise<void> {
    await this.db.writeRemote(async () => {
      const writes = await this.documentWrites(spaceId, documents, { partial: true });
      writes.push(...(await this.pruneListedDocuments(spaceId, documents)));
      // Last, so this listing wins over the stale copy of itself that unlisting
      // a pruned document produces.
      writes.push(
        this.collectionWrite(
          spaceId,
          collections.documents,
          documents.map((document) => document.id),
        ),
      );
      return writes;
    });
  }

  /** Store a category's documents as the server grouped them. */
  async writeDocumentsByCategory(
    spaceId: string,
    documentsByCategory: Record<string, DocumentWithProperties[]>,
    requestedSlugs: string[],
  ): Promise<void> {
    await this.db.writeRemote(async () => {
      const documents = Object.values(documentsByCategory).flat();
      const writes = await this.documentWrites(spaceId, documents, { partial: true });

      // A slug the server answered with nothing still has a known answer.
      for (const slug of new Set(requestedSlugs)) {
        writes.push(
          this.collectionWrite(
            spaceId,
            collections.categoryDocuments(slug),
            (documentsByCategory[slug] ?? []).map((document) => document.id),
          ),
        );
      }
      return writes;
    });
  }

  /** Store documents seen outside any listing — a page of a cursor walk, say. */
  async writeDocuments(
    spaceId: string,
    documents: DocumentWithProperties[],
  ): Promise<void> {
    await this.db.writeRemote(
      async () => await this.documentWrites(spaceId, documents, { partial: true }),
    );
  }

  /** Store a document the server returned in full, body included. */
  async writeDocument(spaceId: string, document: DocumentWithProperties): Promise<void> {
    await this.db.writeRemote(async () => [
      ...(await this.documentWrites(spaceId, [document], { partial: false })),
      ...(await this.listDocumentWrites(spaceId, document)),
    ]);
  }

  async patchDocument(
    spaceId: string,
    documentIdOrSlug: string,
    patch: {
      /** A function when the new value depends on the stored one. */
      document?:
        | Partial<DocumentFields>
        | ((current: DocumentFields) => Partial<DocumentFields>);
      /** `null` removes the property, mirroring the PATCH body. */
      properties?: Record<string, string | string[] | null>;
    },
  ): Promise<ReplicaOperation | null> {
    return await this.db.writeOptimistic(async () => {
      const record = await this.documentRecord(spaceId, documentIdOrSlug);
      if (!record) return [];

      const fields =
        typeof patch.document === "function"
          ? patch.document(toEntity<DocumentFields>(record))
          : patch.document;
      const writes: ReplicaWrite[] = [
        { store: replicaStores.document, put: { ...record, ...fields } },
      ];
      for (const [key, value] of Object.entries(patch.properties ?? {})) {
        writes.push(
          value === null
            ? {
                store: replicaStores.property,
                remove: [spaceId, record.id, key],
              }
            : {
                store: replicaStores.property,
                put: { spaceId, documentId: record.id, key, value },
              },
        );
      }
      return writes;
    });
  }

  /**
   * Archiving keeps the local copy but takes it out of every listing. The server
   * stops serving an archived document below `editor`, so for a viewer the cached
   * body outlives the access it was fetched with.
   */
  async archiveDocument(spaceId: string, documentId: string): Promise<void> {
    await this.db.writeRemote(async () => await this.archiveWrites(spaceId, documentId));
  }

  async archiveDocumentOptimistic(
    spaceId: string,
    documentId: string,
  ): Promise<ReplicaOperation | null> {
    return await this.db.writeOptimistic(
      async () => await this.archiveWrites(spaceId, documentId),
    );
  }

  /** Drop a document and unlist it everywhere it was listed. */
  async removeDocument(spaceId: string, documentId: string): Promise<void> {
    await this.db.writeRemote(
      async () => await this.documentRemovalWrites(spaceId, documentId),
    );
  }

  async removeDocumentOptimistic(
    spaceId: string,
    documentId: string,
  ): Promise<ReplicaOperation | null> {
    return await this.db.writeOptimistic(
      async () => await this.documentRemovalWrites(spaceId, documentId),
    );
  }

  // ------------------------------------------------------------- comments

  async readComments(
    spaceId: string,
    documentId: string,
  ): Promise<Comment[] | undefined> {
    const [collection, records] = await Promise.all([
      this.collection(spaceId, collections.comments(documentId)),
      this.db.getByIndex<CommentRecord>(replicaStores.comment, "by_resource", [
        spaceId,
        documentId,
      ]),
    ]);
    return inCollectionOrder(
      collection,
      records.map((record) => toEntity<Comment>(record)),
    );
  }

  subscribeComments(
    spaceId: string,
    documentId: string,
    callback: (comments: Comment[] | undefined) => void,
  ): () => void {
    return this.db.subscribe(
      [replicaStores.comment, replicaStores.collection],
      spaceId,
      () => this.readComments(spaceId, documentId),
      callback,
    );
  }

  async writeComments(
    spaceId: string,
    documentId: string,
    comments: Comment[],
  ): Promise<void> {
    await this.db.writeRemote(async () => {
      const stored = await this.db.getByIndex<CommentRecord>(
        replicaStores.comment,
        "by_resource",
        [spaceId, documentId],
      );
      const incoming = new Set(comments.map((comment) => comment.id));

      return [
        ...comments.map((comment) => ({
          store: replicaStores.comment,
          put: { ...comment, spaceId } satisfies CommentRecord,
        })),
        ...stored
          .filter((record) => !incoming.has(record.id))
          .map((record) => ({
            store: replicaStores.comment,
            remove: [spaceId, record.id],
          })),
        this.collectionWrite(
          spaceId,
          collections.comments(documentId),
          comments.map((comment) => comment.id),
        ),
      ];
    });
  }

  async addComment(
    spaceId: string,
    documentId: string,
    comment: Comment,
  ): Promise<ReplicaOperation | null> {
    return await this.db.writeOptimistic(async () => [
      { store: replicaStores.comment, put: { ...comment, spaceId } },
      ...(await this.appendToCollection(
        spaceId,
        collections.comments(documentId),
        comment.id,
      )),
    ]);
  }

  /** Swap a comment written before the request for the one the server stored. */
  async replaceComment(
    spaceId: string,
    documentId: string,
    temporaryId: string,
    comment: Comment,
  ): Promise<void> {
    await this.db.writeRemote(async () => {
      const name = collections.comments(documentId);
      const collection = await this.collection(spaceId, name);
      const ids = collection
        ? collection.ids.map((id) => (id === temporaryId ? comment.id : id))
        : [];

      return [
        { store: replicaStores.comment, remove: [spaceId, temporaryId] },
        { store: replicaStores.comment, put: { ...comment, spaceId } },
        ...(collection
          ? [
              {
                store: replicaStores.collection,
                put: {
                  ...collection,
                  ids: ids.includes(comment.id) ? ids : [...ids, comment.id],
                },
              },
            ]
          : []),
      ];
    });
  }

  async patchComments(
    spaceId: string,
    commentIds: string[],
    patch: Partial<Comment>,
  ): Promise<ReplicaOperation | null> {
    return await this.db.writeOptimistic(async () => {
      const writes: ReplicaWrite[] = [];
      for (const commentId of commentIds) {
        const record = await this.db.get<CommentRecord>(replicaStores.comment, [
          spaceId,
          commentId,
        ]);
        if (record) {
          writes.push({ store: replicaStores.comment, put: { ...record, ...patch } });
        }
      }
      return writes;
    });
  }

  async removeComments(
    spaceId: string,
    documentId: string,
    commentIds: string[],
  ): Promise<void> {
    await this.db.writeRemote(
      async () => await this.commentRemovalWrites(spaceId, documentId, commentIds),
    );
  }

  async removeCommentsOptimistic(
    spaceId: string,
    documentId: string,
    commentIds: string[],
  ): Promise<ReplicaOperation | null> {
    return await this.db.writeOptimistic(
      async () => await this.commentRemovalWrites(spaceId, documentId, commentIds),
    );
  }

  private async commentRemovalWrites(
    spaceId: string,
    documentId: string,
    commentIds: string[],
  ): Promise<ReplicaWrite[]> {
    return [
      ...commentIds.map((commentId) => ({
        store: replicaStores.comment,
        remove: [spaceId, commentId],
      })),
      ...(await this.removeFromCollection(
        spaceId,
        collections.comments(documentId),
        ...commentIds,
      )),
    ];
  }

  // ----------------------------------------------------------- extensions

  async readExtensions(
    spaceId: string,
  ): Promise<
    { extensions: ExtensionInfo[]; errors: ExtensionManifestError[] } | undefined
  > {
    const [collection, records] = await Promise.all([
      this.collection(spaceId, collections.extensions),
      this.db.getSpace<ExtensionRecord>(replicaStores.extension, spaceId),
    ]);
    const extensions = inCollectionOrder(
      collection,
      records.map((record) => toEntity<ExtensionInfo>(record)),
    );
    if (!extensions) return undefined;

    return { extensions, errors: collection?.meta?.errors ?? [] };
  }

  subscribeExtensions(
    spaceId: string,
    callback: (
      response:
        | { extensions: ExtensionInfo[]; errors: ExtensionManifestError[] }
        | undefined,
    ) => void,
  ): () => void {
    return this.db.subscribe(
      [replicaStores.extension, replicaStores.collection],
      spaceId,
      () => this.readExtensions(spaceId),
      callback,
    );
  }

  async writeExtensions(
    spaceId: string,
    response: { extensions: ExtensionInfo[]; errors: ExtensionManifestError[] },
  ): Promise<void> {
    await this.db.writeRemote([
      ...response.extensions.map((extension) => ({
        store: replicaStores.extension,
        put: { ...extension, spaceId } satisfies ExtensionRecord,
      })),
      this.collectionWrite(
        spaceId,
        collections.extensions,
        response.extensions.map((extension) => extension.id),
        { errors: response.errors },
      ),
    ]);
  }

  async writeExtension(spaceId: string, extension: ExtensionInfo): Promise<void> {
    await this.db.writeRemote(async () => [
      { store: replicaStores.extension, put: { ...extension, spaceId } },
      ...(await this.appendToCollection(spaceId, collections.extensions, extension.id)),
    ]);
  }

  async removeExtension(spaceId: string, extensionId: string): Promise<void> {
    await this.db.writeRemote(async () => [
      ...(await this.removeFromCollection(spaceId, collections.extensions, extensionId)),
      { store: replicaStores.extension, remove: [spaceId, extensionId] },
    ]);
  }

  // -------------------------------------------------------------- rollback

  async rollback(operation: ReplicaOperation | null): Promise<void> {
    await this.db.rollback(operation);
  }

  // --------------------------------------------------------------- internals

  private spaceWrite(space: Space): ReplicaWrite {
    return { store: replicaStores.space, put: { ...space, spaceId: ROOT_SPACE } };
  }

  /** `properties` are this document's own rows, not the space's. */
  private toDocument(
    record: DocumentRecord,
    properties: PropertyRecord[],
  ): DocumentWithProperties {
    const fields = toEntity<DocumentFields>(record);
    return {
      ...fields,
      // A listing reports an absent body as empty, and so do we.
      content: fields.content ?? "",
      properties: Object.fromEntries(
        properties.map((property) => [property.key, property.value]),
      ),
    };
  }

  /**
   * Documents and their properties for exactly these ids — one transaction per
   * store, covering every id, rather than a scan of the whole space. A caller
   * that wants one database's rows or one category's rows must not pay for
   * every document the space holds to get them.
   */
  private async documentsById(
    spaceId: string,
    ids: string[],
  ): Promise<Map<string, DocumentWithProperties>> {
    if (ids.length === 0) return new Map();

    const keys = ids.map((id) => [spaceId, id]);
    const [records, propertyRows] = await Promise.all([
      this.db.getMany<DocumentRecord>(replicaStores.document, keys),
      this.db.getManyByIndex<PropertyRecord>(replicaStores.property, "by_document", keys),
    ]);

    const result = new Map<string, DocumentWithProperties>();
    records.forEach((record, index) => {
      if (record)
        result.set(record.id, this.toDocument(record, propertyRows[index] ?? []));
    });
    return result;
  }

  private async documentsInCollection(
    spaceId: string,
    collection: CollectionRecord,
  ): Promise<DocumentWithProperties[] | undefined> {
    const documentsById = await this.documentsById(spaceId, collection.ids);
    return inCollectionOrder(collection, [...documentsById.values()]);
  }

  private async documentRecord(
    spaceId: string,
    documentIdOrSlug: string,
  ): Promise<DocumentRecord | null> {
    const byIdRecord = await this.db.get<DocumentRecord>(replicaStores.document, [
      spaceId,
      documentIdOrSlug,
    ]);
    if (byIdRecord) return byIdRecord;

    const [bySlug] = await this.db.getByIndex<DocumentRecord>(
      replicaStores.document,
      "by_slug",
      [spaceId, documentIdOrSlug],
    );
    return bySlug ?? null;
  }

  /**
   * Merge documents into the store.
   *
   * A listing omits the body, so a partial write must not overwrite a body we
   * already hold — the same document is listed and opened, and the listing
   * arriving second would otherwise blank the open editor.
   */
  private async documentWrites(
    spaceId: string,
    documents: DocumentWithProperties[],
    options: { partial: boolean },
  ): Promise<ReplicaWrite[]> {
    if (documents.length === 0) return [];

    // Only ever looked up by the id of a document being written, so this reads
    // exactly those rows — one transaction covering every id — rather than
    // every document and property the space holds. A space with tens of
    // thousands of documents must not pay for all of them on every write of a
    // handful.
    const keys = documents.map((document) => [spaceId, document.id]);
    const [storedRecords, storedPropertyRows] = await Promise.all([
      this.db.getMany<DocumentRecord>(replicaStores.document, keys),
      this.db.getManyByIndex<PropertyRecord>(replicaStores.property, "by_document", keys),
    ]);

    const writes: ReplicaWrite[] = [];

    documents.forEach((document, index) => {
      const { properties, ...fields } = document;
      const next: Record<string, unknown> = { ...fields, spaceId };
      if (options.partial) delete next.content;
      for (const [key, value] of Object.entries(next)) {
        if (value === undefined) delete next[key];
      }

      writes.push({
        store: replicaStores.document,
        put: { ...storedRecords[index], ...next } as DocumentRecord,
      });

      for (const [key, value] of Object.entries(properties ?? {})) {
        writes.push({
          store: replicaStores.property,
          put: { spaceId, documentId: document.id, key, value },
        });
      }
      // A property the response no longer carries has been deleted.
      const propertyKeys = new Set(Object.keys(properties ?? {}));
      for (const property of storedPropertyRows[index] ?? []) {
        if (propertyKeys.has(property.key)) continue;
        writes.push({
          store: replicaStores.property,
          remove: [spaceId, document.id, property.key],
        });
      }
    });

    return writes;
  }

  /**
   * List a document we hold in full, so a newly created one shows up in a
   * cache-hydrated sidebar without waiting for a refetch.
   *
   * Only direct membership is inferred here; a document inherits its parent's
   * categories by a server rule this cache deliberately does not reimplement,
   * and the next listing settles it.
   */
  private async listDocumentWrites(
    spaceId: string,
    document: DocumentWithProperties,
  ): Promise<ReplicaWrite[]> {
    // Archived documents are readable but never listed.
    if (document.archived) return [];

    const names: string[] = [collections.documents];
    if (document.type !== "record") {
      names.push(
        ...[document.properties?.category, document.properties?.collection]
          .flatMap((value) => (Array.isArray(value) ? value : value ? [value] : []))
          .map((slug) => collections.categoryDocuments(slug)),
      );
    }

    const writes: ReplicaWrite[] = [];
    for (const name of names) {
      writes.push(...(await this.appendToCollection(spaceId, name, document.id)));
    }
    return writes;
  }

  private async archiveWrites(
    spaceId: string,
    documentId: string,
  ): Promise<ReplicaWrite[]> {
    const record = await this.documentRecord(spaceId, documentId);
    return [
      ...(record
        ? [
            {
              store: replicaStores.document,
              put: { ...record, archived: true } satisfies DocumentRecord,
            },
          ]
        : []),
      ...(await this.unlistEverywhere(spaceId, documentId)),
    ];
  }

  private async documentRemovalWrites(
    spaceId: string,
    documentId: string,
  ): Promise<ReplicaWrite[]> {
    const properties = await this.db.getByIndex<PropertyRecord>(
      replicaStores.property,
      "by_document",
      [spaceId, documentId],
    );

    return [
      { store: replicaStores.document, remove: [spaceId, documentId] },
      ...properties.map((property) => ({
        store: replicaStores.property,
        remove: [spaceId, documentId, property.key],
      })),
      ...(await this.unlistEverywhere(spaceId, documentId)),
      {
        store: replicaStores.collection,
        remove: [spaceId, collections.comments(documentId)],
      },
    ];
  }

  /**
   * Documents the space listing no longer contains and nothing else needs.
   * A row we hold a body for stays: it is addressable on its own, and dropping
   * it would evict the document the user most likely has open.
   */
  private async pruneListedDocuments(
    spaceId: string,
    documents: DocumentWithProperties[],
  ): Promise<ReplicaWrite[]> {
    const listed = new Set(documents.map((document) => document.id));
    const stored = await this.db.getSpace<DocumentRecord>(
      replicaStores.document,
      spaceId,
    );
    const writes: ReplicaWrite[] = [];

    for (const record of stored) {
      if (listed.has(record.id) || record.content !== undefined) continue;
      writes.push(...(await this.documentRemovalWrites(spaceId, record.id)));
    }
    return writes;
  }

  // ------------------------------------------------------------ collections

  private async collection(
    spaceId: string,
    name: string,
  ): Promise<CollectionRecord | null> {
    return await this.db.get<CollectionRecord>(replicaStores.collection, [spaceId, name]);
  }

  private collectionWrite(
    spaceId: string,
    name: string,
    ids: string[],
    meta?: CollectionRecord["meta"],
  ): ReplicaWrite {
    return {
      store: replicaStores.collection,
      put: { spaceId, name, ids, ...(meta ? { meta } : {}) },
    };
  }

  /**
   * Extend a list we already hold. A list we have never fetched stays absent
   * rather than becoming a one-entry list that reads as complete.
   */
  private async appendToCollection(
    spaceId: string,
    name: string,
    id: string,
  ): Promise<ReplicaWrite[]> {
    const collection = await this.collection(spaceId, name);
    if (!collection || collection.ids.includes(id)) return [];
    return [
      {
        store: replicaStores.collection,
        put: { ...collection, ids: [...collection.ids, id] },
      },
    ];
  }

  private async removeFromCollection(
    spaceId: string,
    name: string,
    ...ids: string[]
  ): Promise<ReplicaWrite[]> {
    const collection = await this.collection(spaceId, name);
    if (!collection) return [];

    const remaining = collection.ids.filter((candidate) => !ids.includes(candidate));
    if (remaining.length === collection.ids.length) return [];
    return [{ store: replicaStores.collection, put: { ...collection, ids: remaining } }];
  }

  private async unlistEverywhere(spaceId: string, id: string): Promise<ReplicaWrite[]> {
    const records = await this.db.getSpace<CollectionRecord>(
      replicaStores.collection,
      spaceId,
    );

    return records
      .filter((collection) => collection.ids.includes(id))
      .map((collection) => ({
        store: replicaStores.collection,
        put: {
          ...collection,
          ids: collection.ids.filter((candidate) => candidate !== id),
        },
      }));
  }

  private async clearSpaceWrites(spaceId: string): Promise<ReplicaWrite[]> {
    const writes: ReplicaWrite[] = [];

    for (const store of [
      replicaStores.document,
      replicaStores.category,
      replicaStores.comment,
      replicaStores.extension,
      replicaStores.collection,
    ] as const) {
      for (const record of await this.db.getSpace(store, spaceId)) {
        const identifier =
          (record as { id?: string; name?: string }).id ??
          (record as { name?: string }).name;
        if (identifier !== undefined)
          writes.push({ store, remove: [spaceId, identifier] });
      }
    }
    for (const record of await this.db.getSpace<PropertyRecord>(
      replicaStores.property,
      spaceId,
    )) {
      writes.push({
        store: replicaStores.property,
        remove: [spaceId, record.documentId, record.key],
      });
    }
    return writes;
  }
}
