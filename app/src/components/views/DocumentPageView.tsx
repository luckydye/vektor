import { useLocation, useNavigate } from "@solidjs/router";
import {
  createEffect,
  createMemo,
  createSignal,
  type JSX,
  on,
  onCleanup,
  onMount,
  Show,
} from "solid-js";
import { Dynamic, Portal } from "solid-js/web";
import { twMerge } from "tailwind-merge";
import { canEdit } from "#acl/permissions.ts";
import { api } from "#api/client.ts";
import { BottomBanner } from "#components/BottomBanner.tsx";
import { Breadcrumbs } from "#components/Breadcrumbs.tsx";
import { DocumentActions } from "#components/DocumentActions.tsx";
import { DocumentBody } from "#components/DocumentBody.tsx";
import { DocumentContent } from "#components/DocumentContent.tsx";
import { DocumentExtensionViews } from "#components/DocumentExtensionViews.tsx";
import { DocumentProperties } from "#components/DocumentProperties.tsx";
import { HeaderImage } from "#components/HeaderImage.tsx";
import { NewDocumentPicker } from "#components/NewDocumentPicker.tsx";
import { RestoreButton } from "#components/RestoreButton.tsx";
import { RevisionsSidebar } from "#components/RevisionsSidebar.tsx";
import { RevisionView } from "#components/RevisionView.tsx";
import { TitleEditor } from "#components/TitleEditor.tsx";
import { useQuery } from "#composeables/query.ts";
import { useDocumentContext } from "#composeables/useDocument.ts";
import { editing, resetEditingState } from "#composeables/useEditor.ts";
import { useExtensions } from "#composeables/useExtensions.ts";
import { usePageTitle } from "#composeables/usePageTitle.ts";
import { usePersistedState } from "#composeables/usePersistedState.ts";
import { useSpace } from "#composeables/useSpace.ts";
import { useToast } from "#composeables/useToast.ts";
import { useLocale } from "#composeables/useTranslation.ts";
import { optionalPropertyValueToText } from "#documents/properties.ts";
import { placeholderDocumentTitle, repositoryDocumentType } from "#documents/types.ts";
import { formatRelativeTime } from "#utils/dateFormat.ts";
import { isWorkflowCreationEnabled } from "#utils/spacePreferences.ts";
import { spacePath } from "#utils/utils.ts";

interface Props {
  documentSlug?: string;
  draftType?: string;
  draftCategory?: string;
  draftTitle?: string;
  draftParent?: string;
  ssrNow?: number;
}

const AUTO_CREATE_TYPES: Record<string, { title: string; content: string }> = {
  database: {
    title: placeholderDocumentTitle("database"),
    content: "",
  },
  repository: {
    title: placeholderDocumentTitle("repository"),
    // A repository's contents live in git, so the document carries none.
    content: "",
  },
  canvas: {
    title: placeholderDocumentTitle("canvas"),
    content: JSON.stringify({ version: 1, shapes: [], strokes: [] }),
  },
  workflow: {
    title: placeholderDocumentTitle("workflow"),
    content: [
      "// Workflow script.",
      "// `await runJob(extensionId, jobId, inputs)` runs an extension job and",
      "// resolves with its outputs. The value you return becomes the run result.",
      "",
    ].join("\n"),
  },
};

export function DocumentPageView(props: Props) {
  const lang = useLocale();
  const navigate = useNavigate();
  const location = useLocation();
  const [now, setNow] = createSignal(props.ssrNow ?? Date.now());

  const { currentSpace } = useSpace();
  const { extensions } = useExtensions();
  const toast = useToast();
  const { canUseDocumentEditor, setDocumentContext, resetDocumentContext } =
    useDocumentContext();

  const isDraft = createMemo(() => !props.documentSlug);
  const draftTypeParam = createMemo(() => props.draftType ?? "");
  const showPicker = createMemo(() => isDraft() && !draftTypeParam());
  const draftCategory = createMemo(() =>
    isDraft() ? props.draftCategory || undefined : undefined,
  );
  const draftTitle = createMemo(() =>
    isDraft() ? props.draftTitle?.trim() || undefined : undefined,
  );
  const draftParent = createMemo(() =>
    isDraft() ? props.draftParent || undefined : undefined,
  );

  const docQuery = useQuery({
    queryKey: createMemo(() => [
      "wiki_document_slug",
      currentSpace()?.id,
      props.documentSlug,
    ]),
    queryFn: async () => {
      const spaceId = currentSpace()?.id;
      if (!spaceId || !props.documentSlug) return null;
      return await api.document.get(spaceId, props.documentSlug);
    },
    initialData: async () => {
      const spaceId = currentSpace()?.id;
      if (!spaceId || !props.documentSlug) return undefined;
      return await api.document.getCached(spaceId, props.documentSlug);
    },
    subscribe: (callback) => {
      const spaceId = currentSpace()?.id;
      if (!spaceId || !props.documentSlug) return () => {};
      return api.document.subscribeCached(spaceId, props.documentSlug, callback);
    },
    enabled: createMemo(() => !isDraft() && !!currentSpace()?.id && !!props.documentSlug),
  });

  const doc = createMemo(() => docQuery.data());
  const [realtimeAccess, setRealtimeAccess] = createSignal<"edit" | "view" | "none">();

  createEffect(
    on(
      () => doc()?.id,
      () => setRealtimeAccess(undefined),
      { defer: true },
    ),
  );

  const breadcrumbsQuery = useQuery({
    queryKey: createMemo(() => ["document_breadcrumbs", currentSpace()?.id, doc()?.id]),
    queryFn: async () => {
      const spaceId = currentSpace()?.id;
      const docId = doc()?.id;
      if (!spaceId || !docId) return [];
      return await api.documentBreadcrumbs.get(spaceId, docId);
    },
    enabled: createMemo(() => !isDraft() && !!currentSpace()?.id && !!doc()?.id),
  });

  const categoriesQuery = useQuery({
    queryKey: createMemo(() => ["categories", currentSpace()?.id]),
    queryFn: async () => {
      const spaceId = currentSpace()?.id;
      if (!spaceId) return [];
      return (await api.categories.get(spaceId)).categories;
    },
    enabled: createMemo(() => !isDraft() && !!currentSpace()?.id),
  });

  const titleDragUrl = createMemo(() => {
    const slug = doc()?.slug;
    return slug ? spacePath(currentSpace()?.slug, `/doc/${slug}`) : undefined;
  });

  createEffect(() => {
    const d = doc();
    if (!d || props.documentSlug === d.slug) return;
    const fullPath = `${location.pathname}${location.search}${location.hash}`;
    navigate(fullPath.replace(`/doc/${props.documentSlug}`, `/doc/${d.slug}`), {
      replace: true,
      resolve: false,
    });
  });

  const allBreadcrumbs = createMemo(() => breadcrumbsQuery.data() ?? []);
  const parentBreadcrumbs = createMemo(() => allBreadcrumbs().slice(0, -1));

  const docCategory = createMemo(() => {
    const categories = categoriesQuery.data();
    if (!categories) return null;
    for (const crumb of allBreadcrumbs()) {
      if (crumb.categorySlug) {
        return categories.find((c) => c.slug === crumb.categorySlug) ?? null;
      }
    }
    return null;
  });

  const documentType = createMemo(() =>
    isDraft() ? draftTypeParam() || "document" : (doc()?.type ?? "document"),
  );

  const isCanvas = createMemo(() => documentType() === "canvas");
  const isApp = createMemo(() => documentType() === "app");
  const isWorkflow = createMemo(() => documentType() === "workflow");
  const isDatabase = createMemo(() => documentType() === "database");
  const isRecord = createMemo(() => documentType() === "record");
  const isRegularDocument = createMemo(() => documentType() === "document");
  const isRepository = createMemo(() => documentType() === repositoryDocumentType);
  /**
   * Views that carry their own name and their own sense of when they changed:
   * repeating the document title above them, or a footer saying how long ago
   * they were updated, only says it twice.
   */
  const isSelfTitled = createMemo(() => isDatabase() || isRepository());
  const isFullHeightView = createMemo(() => isDatabase() || isWorkflow());
  const isPaddedDocument = createMemo(
    () => !isCanvas() && !isApp() && !isWorkflow() && !isDatabase(),
  );

  const documentRightViews = createMemo(
    () => {
      if (isDraft() || documentType() !== "document") return [];

      return extensions().flatMap((extension) =>
        (extension.routes || [])
          .filter((route) => route.placements?.includes("document"))
          .map((route) => ({ extensionId: extension.id, route })),
      );
    },
    undefined,
    {
      equals: (a, b) =>
        a.length === b.length &&
        a.every(
          (view, index) =>
            view.extensionId === b[index]?.extensionId &&
            view.route.path === b[index]?.route.path,
        ),
    },
  );

  const userCanEdit = createMemo(() => {
    const access = realtimeAccess();
    return (
      access === "edit" || (access === undefined && canEdit(currentSpace()?.userRole))
    );
  });

  const isReadonly = createMemo(() =>
    isDraft()
      ? false
      : !!(
          doc()?.readonly ||
          doc()?.archived ||
          isCanvas() ||
          isApp() ||
          isWorkflow() ||
          isDatabase()
        ),
  );

  const title = createMemo(() =>
    isDraft()
      ? (draftTitle() ?? placeholderDocumentTitle(documentType()))
      : (doc()?.properties?.title as string) || placeholderDocumentTitle("document"),
  );

  const headerImageSrc = createMemo(() =>
    optionalPropertyValueToText(doc()?.properties?.headerImage),
  );
  const headerImageAspectRatio = createMemo(() => doc()?.headerImageAspectRatio ?? null);
  const isPortraitHeader = createMemo(() => {
    const ratio = headerImageAspectRatio();
    return !isDraft() && !!headerImageSrc() && ratio !== null && ratio < 1;
  });

  const defaultLayout = createMemo(() =>
    documentType() === "document" ? "document" : "full",
  );
  const effectiveLayout = createMemo(() =>
    isDraft() ? defaultLayout() : doc()?.properties?.layout || defaultLayout(),
  );

  const updatedAtStr = createMemo(() => {
    const updatedAt = doc()?.updatedAt;
    return updatedAt ? formatRelativeTime(updatedAt, lang, { now: now() }) : "";
  });

  const [redirecting, setRedirecting] = createSignal(false);
  const [hasMounted, setHasMounted] = createSignal(false);
  const { value: tableOfContentsVisible, commit: setTableOfContentsVisible } =
    usePersistedState<boolean>({
      key: "document-table-of-contents-visible",
      fallback: true,
    });
  const hasDocumentAside = () =>
    (hasMounted() && isRegularDocument() && tableOfContentsVisible()) ||
    documentRightViews().length > 0;

  async function maybeAutoCreateDraft() {
    if (!hasMounted()) return;
    if (!isDraft()) return;
    if (redirecting()) return;
    const autoCreate = AUTO_CREATE_TYPES[documentType()];
    const space = currentSpace();
    if (!autoCreate || !space) return;
    if (documentType() === "workflow" && !isWorkflowCreationEnabled(space.preferences)) {
      navigate("/new", { replace: true });
      return;
    }
    if (!userCanEdit()) {
      navigate("/");
      return;
    }
    setRedirecting(true);
    try {
      const newDoc = await api.documents.post(space.id, {
        type: documentType(),
        content: autoCreate.content,
        ...(draftParent() ? { parentId: draftParent() } : {}),
        properties: {
          title: draftTitle() ?? autoCreate.title,
          ...(draftCategory() ? { category: draftCategory() } : {}),
        },
      });
      navigate(`/doc/${newDoc.slug}`);
    } catch (error) {
      setRedirecting(false);
      throw error;
    }
  }

  onMount(() => {
    setHasMounted(true);
    setNow(Date.now());

    const unsubscribeAccessChanges = api.subscribeToRealtimeAccessChanges((change) => {
      const currentDocument = doc();
      if (
        change.spaceId !== currentSpace()?.id ||
        change.scope !== "document" ||
        change.resourceId !== currentDocument?.id ||
        change.access === "refresh"
      ) {
        return;
      }

      setRealtimeAccess(change.access);
      if (change.access === "edit") {
        toast.show("You can edit this document again.", "info");
        return;
      }

      resetEditingState();
      if (change.access === "view") {
        toast.show("Your access to this document changed to view only.", "info");
        return;
      }

      toast.show("Your access to this document was revoked.", "error", 10_000);
      navigate("/", { replace: true });
    });

    onCleanup(unsubscribeAccessChanges);
  });

  createEffect(() => {
    void [isDraft(), documentType(), currentSpace(), userCanEdit(), draftCategory()];
    void maybeAutoCreateDraft().catch((error) => {
      console.error("Failed to create draft document", error);
      toast.error(
        error instanceof Error ? error.message : "Failed to create the document",
      );
    });
  });

  onCleanup(() => {
    resetEditingState();
    resetDocumentContext();
  });

  usePageTitle(title);

  createEffect(() => {
    setDocumentContext({
      documentId: doc()?.id,
      documentType: documentType(),
      readonly: isReadonly(),
      publishedVersion: doc()?.publishedRev ?? null,
      userCanEdit: userCanEdit(),
    });
    if (!canUseDocumentEditor() && editing()) resetEditingState();
  });

  const initialProperties = () =>
    isDraft()
      ? draftCategory()
        ? { category: draftCategory() }
        : {}
      : { ...doc()?.properties, parentId: doc()?.parentId };

  const titleRow = (): JSX.Element => (
    <div class="flex w-full items-start justify-between">
      <Dynamic
        component={isDraft() ? "div" : "page-target"}
        class="block min-w-0 flex-1 [&[data-dragging]]:opacity-50"
        attr:data-document-id={doc()?.id}
        attr:data-document-type={doc()?.type ?? undefined}
        attr:data-space-id={currentSpace()?.id}
        attr:data-document-url={titleDragUrl()}
      >
        <TitleEditor
          initialEditMode={isDraft()}
          title={title()}
          documentId={doc()?.id}
          spaceId={currentSpace()?.id as string}
          canEdit={userCanEdit()}
        />
      </Dynamic>
    </div>
  );

  const documentPropertiesBlock = (layout?: "labeled"): JSX.Element => (
    <DocumentProperties
      documentId={doc()?.id}
      documentType={documentType()}
      layout={layout}
      readonly={!userCanEdit()}
      initialProperties={initialProperties()}
      initialCategory={null}
    />
  );

  const breadcrumbs = (): JSX.Element => (
    <Show when={!isDraft()}>
      <Breadcrumbs
        category={docCategory()}
        parents={parentBreadcrumbs()}
        currentTitle={title()}
        documentId={doc()?.id}
        spaceId={currentSpace()?.id}
        canEdit={userCanEdit()}
      />
    </Show>
  );

  const documentActions = (): JSX.Element => (
    <DocumentActions
      title={title()}
      headerImage={headerImageSrc()}
      tableOfContentsVisible={tableOfContentsVisible()}
      onToggleTableOfContents={
        isRegularDocument()
          ? () => setTableOfContentsVisible(!tableOfContentsVisible())
          : undefined
      }
    />
  );

  const documentAside = (): JSX.Element => (
    <DocumentExtensionViews
      views={documentRightViews()}
      documentId={doc()?.id ?? null}
      fullWidth={effectiveLayout() === "full"}
      onHideTableOfContents={() => setTableOfContentsVisible(false)}
      spaceId={currentSpace()?.id as string}
      tableOfContents={hasMounted() && isRegularDocument() && tableOfContentsVisible()}
    />
  );

  return (
    <>
      <Show
        when={currentSpace() && (isDraft() ? !redirecting() : doc())}
        fallback={
          <Show when={!isDraft()}>
            <Show
              when={!docQuery.isLoading()}
              fallback={
                <div class="flex h-64 items-center justify-center text-neutral-400">
                  Loading…
                </div>
              }
            >
              <div class="flex min-h-[60vh] flex-col items-center justify-center gap-3 text-neutral-500">
                <p class="font-semibold text-2xl text-neutral-800">404</p>
                <p>Document not found.</p>
                <a
                  href={`/${currentSpace()?.slug ?? ""}/`}
                  class="text-sm underline hover:text-neutral-800"
                >
                  Back to space
                </a>
              </div>
            </Show>
          </Show>
        }
      >
        <div class={twMerge(isFullHeightView() && "flex h-full min-h-screen flex-col")}>
          <inset-view
            class={twMerge(
              "block min-h-0 flex-1",
              isFullHeightView() && "flex flex-col",
              !isCanvas() && "md:mr-(--inset-right) md:ml-(--inset-left)",
            )}
          >
            <div
              class={twMerge(
                "relative mx-auto h-full w-full",
                isFullHeightView() && "flex min-h-0 flex-1 flex-col",
                isDatabase() || isRecord() || effectiveLayout() === "full"
                  ? "max-w-full"
                  : "max-w-(--document-width)",
              )}
            >
              <div
                data-type={documentType()}
                data-updated-at={doc()?.updatedAt as string | undefined}
                data-created-at={doc()?.createdAt as string | undefined}
                data-layout={effectiveLayout()}
                class={twMerge(
                  "relative flex h-full w-full min-w-0 max-w-full flex-col",
                  isFullHeightView() && "min-h-0 flex-1",
                  effectiveLayout() !== "full" &&
                    "min-[1920px]:left-[-80px] print:left-0",
                )}
              >
                <Show when={doc()?.archived}>
                  <BottomBanner class="archived-banner">
                    <div class="pointer-events-auto flex w-full flex-col gap-3 rounded-lg border border-yellow-200 bg-yellow-50 px-5 py-4 shadow-large sm:flex-row sm:items-center sm:justify-between">
                      <div class="min-w-0">
                        <p class="font-semibold text-size-medium text-yellow-900">
                          ⚠️ This document is archived
                        </p>
                        <p class="my-0! text-size-small text-yellow-700">
                          This document has been archived and is no longer actively
                          maintained.
                        </p>
                      </div>
                      <RestoreButton documentId={doc()?.id as string} />
                    </div>
                  </BottomBanner>
                </Show>

                <Show when={isCanvas()}>
                  <div class="pointer-events-none absolute top-0 right-0 left-0 z-20 block md:right-(--inset-right) md:left-(--inset-left)">
                    <div class="sticky top-0 z-10 flex min-h-7 flex-row items-center justify-between gap-6 px-xs py-4 md:px-m">
                      <div class="min-w-0 flex-1">{breadcrumbs()}</div>
                      <DocumentActions title={title()} headerImage={headerImageSrc()} />
                    </div>

                    <inset-view
                      id="document-properties"
                      class="mb-l block px-xs md:px-m print:px-0"
                    >
                      {documentPropertiesBlock()}
                    </inset-view>
                  </div>
                </Show>

                <Show when={!isCanvas() && !isApp() && isPortraitHeader()}>
                  <div class="sticky top-0 z-10 flex min-h-7 flex-row items-center justify-between gap-6 border-neutral-50 border-b bg-neutral-10 px-xs py-4 md:px-m">
                    <div class="min-w-0 flex-1">{breadcrumbs()}</div>
                    {documentActions()}
                  </div>

                  <div class="mb-4 flex flex-col gap-xl px-xs md:flex-row md:items-start md:px-xl print:px-0">
                    <HeaderImage
                      class="w-full max-w-[320px] shrink-0"
                      orientation="portrait"
                      aspectRatio={headerImageAspectRatio()}
                      documentId={doc()?.id as string}
                      initialSrc={headerImageSrc()}
                    />

                    <div class="flex min-w-0 flex-1 flex-col">
                      <Show when={!isSelfTitled()}>
                        <inset-view class="flex flex-row justify-between gap-6 bg-neutral-10 py-3xs md:gap-4 print:px-0">
                          {titleRow()}
                        </inset-view>
                      </Show>

                      <inset-view
                        id="document-properties"
                        class={twMerge(
                          "block print:px-0",
                          isSelfTitled() ? "mt-2xs mb-2xs" : "mb-l",
                        )}
                      >
                        {documentPropertiesBlock("labeled")}
                      </inset-view>
                    </div>
                  </div>
                </Show>

                <Show when={!isCanvas() && !isApp() && !isPortraitHeader()}>
                  <Show when={!isDraft() && !isWorkflow()}>
                    <HeaderImage
                      class="mt-4"
                      documentId={doc()?.id as string}
                      initialSrc={optionalPropertyValueToText(
                        doc()?.properties?.headerImage,
                      )}
                    />
                  </Show>

                  <div class="sticky top-0 z-10 flex min-h-7 flex-row items-center justify-between gap-6 border-neutral-50 border-b bg-neutral-10 px-xs py-4 md:px-m">
                    <Show
                      when={isWorkflow()}
                      fallback={<div class="min-w-0 flex-1">{breadcrumbs()}</div>}
                    >
                      <div id="workflow-breadcrumb-slot" class="min-w-0 flex-1" />
                    </Show>
                    {documentActions()}
                  </div>

                  <Show when={!isSelfTitled()}>
                    <inset-view class="flex flex-row justify-between gap-6 bg-neutral-10 px-xs py-3xs md:gap-4 md:px-m print:px-0">
                      {titleRow()}
                    </inset-view>
                  </Show>

                  <Show when={!isSelfTitled()}>
                    <inset-view
                      id="document-properties"
                      class={twMerge(
                        "block px-xs md:px-m print:px-0",
                        isSelfTitled() ? "mt-2xs mb-2xs" : "mb-xl",
                      )}
                    >
                      {documentPropertiesBlock()}
                    </inset-view>
                  </Show>
                </Show>

                <div
                  class={twMerge(
                    isFullHeightView() && "flex min-h-0 flex-1 flex-col",
                    hasDocumentAside() &&
                      effectiveLayout() === "full" &&
                      "xl:grid xl:grid-cols-[minmax(0,1fr)_20rem] xl:items-start xl:gap-6",
                  )}
                >
                  <div
                    class={twMerge(
                      "min-w-0",
                      isFullHeightView() && "flex min-h-0 flex-1 flex-col",
                    )}
                  >
                    <div
                      class={twMerge(
                        "h-full max-w-none overflow-x-auto text-neutral-700",
                        isFullHeightView()
                          ? "flex min-h-0 flex-1 flex-col overflow-hidden"
                          : "h-full overflow-x-auto",
                        isPaddedDocument() && "px-xs md:px-m print:px-0",
                      )}
                    >
                      <Show
                        when={!isDraft()}
                        fallback={
                          <>
                            <DocumentContent
                              spaceId={currentSpace()?.id as string}
                              documentType={documentType()}
                            />
                            <Show when={showPicker()}>
                              <NewDocumentPicker />
                            </Show>
                          </>
                        }
                      >
                        <RevisionView
                          documentId={doc()?.id as string}
                          documentType={documentType()}
                          spaceId={currentSpace()?.id as string}
                        />

                        <DocumentBody
                          content={doc()?.content ?? ""}
                          documentId={doc()?.id as string}
                          documentType={documentType()}
                          extensions={extensions()}
                          properties={doc()?.properties ?? {}}
                          readonly={isReadonly()}
                          spaceId={currentSpace()?.id as string}
                        />
                      </Show>
                    </div>

                    {/* The footer used to be what kept a view off the bottom
                        of the window; without it these need the room back. */}
                    <Show when={isSelfTitled()}>
                      <div class="h-l" />
                    </Show>

                    <Show
                      when={
                        !isDraft() &&
                        !editing() &&
                        !isCanvas() &&
                        !isWorkflow() &&
                        !isSelfTitled()
                      }
                    >
                      <inset-view class="mt-2xs mb-4xs flex items-center justify-end px-xs md:px-m print:px-0">
                        <Show when={doc()?.updatedAt}>
                          <div class="mb-4 flex flex-wrap items-center gap-2 text-neutral-500 text-size-medium">
                            <Show when={hasMounted() && updatedAtStr()}>
                              <span>Updated {updatedAtStr()}</span>
                            </Show>
                          </div>
                        </Show>
                      </inset-view>
                    </Show>
                  </div>
                  <Show when={effectiveLayout() === "full"}>{documentAside()}</Show>
                </div>
              </div>
              <Show when={effectiveLayout() !== "full"}>{documentAside()}</Show>
            </div>
          </inset-view>
        </div>
      </Show>

      <Show when={hasMounted() && !isDraft() && doc()}>
        {(document) => (
          <Portal>
            <RevisionsSidebar documentId={document().id} />
          </Portal>
        )}
      </Show>
    </>
  );
}
