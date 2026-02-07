#!/usr/bin/env bun

export interface WIFDocument {
  slug: string;
  title: string;
  content: string;
  parentSlug?: string;
  path: string;
  level: number;
  categorySlug?: string;
  properties: Record<string, string>;
  createdAt?: string;
  modifiedAt?: string;
  author?: string;
}

export interface WIFMediaFile {
  originalPath: string;
  sanitizedPath: string;
  filename: string;
  extension: string;
  relativeToDocument: string;
}

export interface WIFManifest {
  wifVersion: string;
  exportName: string;
  createdAt: string;
  source: {
    type: string;
    version?: string;
    url?: string;
  };
  stats: {
    documents: number;
    mediaFiles: number;
    totalSizeBytes: number;
  };
}

export interface WIFFrontmatter {
  wif_version: string;
  slug: string;
  title: string;
  created_at?: string;
  modified_at?: string;
  author?: string;
  parent?: string;
  order?: number;
  tags?: string[];
  category?: string;
  properties: Record<string, string>;
}

export interface WIFExport {
  documents: WIFDocument[];
  mediaFiles: WIFMediaFile[];
  manifest: WIFManifest;
}
