import { createMemo, type Component } from "solid-js";
import { Dynamic } from "solid-js/web";
import type { ExtensionInfo } from "#api/client.ts";
import { AppView } from "#components/AppView.tsx";
import { CanvasView } from "#components/CanvasView.tsx";
import {
  DatabaseDocumentView,
  type DatabaseExtensionView,
} from "#components/DatabaseDocumentView.tsx";
import { DocumentContent } from "#components/DocumentContent.tsx";
import { WorkflowView } from "#components/WorkflowView.tsx";
import {
  type DocumentProperties,
  optionalPropertyValueToText,
} from "#documents/properties.ts";

interface Props {
  content: string;
  documentId: string;
  documentType: string;
  extensions: ExtensionInfo[];
  properties: DocumentProperties;
  readonly: boolean;
  spaceId: string;
}

const RichTextDocumentView: Component<Props> = (props) => (
  <DocumentContent
    spaceId={props.spaceId}
    documentId={props.documentId}
    initialHtml={props.content}
    documentType={props.documentType}
    readonly={props.readonly}
  />
);

const DatabaseView: Component<Props> = (props) => {
  const views = createMemo<DatabaseExtensionView[], undefined>(
    () =>
      props.extensions.flatMap((extension) =>
        (extension.routes || [])
          .filter((route) => route.placements?.includes("database"))
          .map((route) => ({
            extensionId: extension.id,
            extensionName: extension.name,
            route,
          })),
      ),
    undefined,
    {
      equals: (a, b) =>
        a.length === b.length &&
        a.every(
          (view, index) =>
            view.extensionId === b[index]?.extensionId &&
            view.extensionName === b[index]?.extensionName &&
            view.route.path === b[index]?.route.path &&
            view.route.title === b[index]?.route.title,
        ),
    },
  );

  return (
    <DatabaseDocumentView
      databaseDocumentId={props.documentId}
      spaceId={props.spaceId}
      views={views()}
      viewConfig={props.properties._databaseViews}
      schemaJson={
        optionalPropertyValueToText(props.properties._schema) ?? undefined
      }
    />
  );
};

const documentViews: Readonly<Record<string, Component<Props>>> = {
  app: (props) => <AppView html={props.content} />,
  canvas: (props) => (
    <CanvasView documentId={props.documentId} spaceId={props.spaceId} />
  ),
  database: DatabaseView,
  workflow: (props) => (
    <WorkflowView documentId={props.documentId} spaceId={props.spaceId} />
  ),
};

export function DocumentBody(props: Props) {
  const view = createMemo(
    () => documentViews[props.documentType] ?? RichTextDocumentView,
  );

  return <Dynamic component={view()} {...props} />;
}
