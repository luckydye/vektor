import { describe, expect, it } from "vitest";
import {
  canAccessSettings,
  canComment,
  canEdit,
  canManageExtensions,
  canView,
  canViewAudit,
  canViewHistory,
  Feature,
  isOwner,
  meetsPermissionLevel,
  Permission,
  resolveFeature,
} from "#acl/permissions.ts";

describe("Permission Utilities", () => {
  describe("meetsPermissionLevel", () => {
    it("should return true when user has exact permission level", () => {
      expect(meetsPermissionLevel(Permission.VIEWER, Permission.VIEWER)).toBe(true);
      expect(meetsPermissionLevel(Permission.EDITOR, Permission.EDITOR)).toBe(true);
      expect(meetsPermissionLevel(Permission.OWNER, Permission.OWNER)).toBe(true);
    });

    it("should return true when user has higher permission level", () => {
      expect(meetsPermissionLevel(Permission.OWNER, Permission.EDITOR)).toBe(true);
      expect(meetsPermissionLevel(Permission.OWNER, Permission.VIEWER)).toBe(true);
      expect(meetsPermissionLevel(Permission.EDITOR, Permission.VIEWER)).toBe(true);
    });

    it("should return false when user has lower permission level", () => {
      expect(meetsPermissionLevel(Permission.VIEWER, Permission.EDITOR)).toBe(false);
      expect(meetsPermissionLevel(Permission.VIEWER, Permission.OWNER)).toBe(false);
      expect(meetsPermissionLevel(Permission.EDITOR, Permission.OWNER)).toBe(false);
    });

    it("should return false when userRole is undefined", () => {
      expect(meetsPermissionLevel(undefined, Permission.VIEWER)).toBe(false);
      expect(meetsPermissionLevel(undefined, Permission.EDITOR)).toBe(false);
      expect(meetsPermissionLevel(undefined, Permission.OWNER)).toBe(false);
    });

    it("should return false for invalid role strings", () => {
      expect(meetsPermissionLevel("invalid", Permission.VIEWER)).toBe(false);
      expect(meetsPermissionLevel("guest", Permission.VIEWER)).toBe(false);
    });
  });

  describe("canView", () => {
    it("should return true for all valid roles", () => {
      expect(canView("viewer")).toBe(true);
      expect(canView("editor")).toBe(true);
      expect(canView("owner")).toBe(true);
    });

    it("should return false for undefined role", () => {
      expect(canView(undefined)).toBe(false);
    });

    it("should return false for invalid role", () => {
      expect(canView("invalid")).toBe(false);
    });
  });

  describe("canEdit", () => {
    it("should return true for editor and owner", () => {
      expect(canEdit("editor")).toBe(true);
      expect(canEdit("owner")).toBe(true);
    });

    it("should return false for viewer", () => {
      expect(canEdit("viewer")).toBe(false);
    });

    it("should return false for undefined role", () => {
      expect(canEdit(undefined)).toBe(false);
    });
  });

  describe("isOwner", () => {
    it("should return true only for owner", () => {
      expect(isOwner("owner")).toBe(true);
    });

    it("should return false for all other roles", () => {
      expect(isOwner("editor")).toBe(false);
      expect(isOwner("viewer")).toBe(false);
    });

    it("should return false for undefined role", () => {
      expect(isOwner(undefined)).toBe(false);
    });
  });

  describe("canAccessSettings", () => {
    it("should return true for owner only", () => {
      expect(canAccessSettings("owner")).toBe(true);
    });

    it("should return false for editor and viewer", () => {
      expect(canAccessSettings("editor")).toBe(false);
      expect(canAccessSettings("viewer")).toBe(false);
    });

    it("should return false for undefined role", () => {
      expect(canAccessSettings(undefined)).toBe(false);
    });
  });

  describe("Permission Hierarchy", () => {
    it("should enforce correct hierarchy: owner > editor > viewer", () => {
      // Owner can do everything
      expect(meetsPermissionLevel(Permission.OWNER, Permission.OWNER)).toBe(true);
      expect(meetsPermissionLevel(Permission.OWNER, Permission.EDITOR)).toBe(true);
      expect(meetsPermissionLevel(Permission.OWNER, Permission.VIEWER)).toBe(true);

      // Editor can do editor, viewer
      expect(meetsPermissionLevel(Permission.EDITOR, Permission.OWNER)).toBe(false);
      expect(meetsPermissionLevel(Permission.EDITOR, Permission.EDITOR)).toBe(true);
      expect(meetsPermissionLevel(Permission.EDITOR, Permission.VIEWER)).toBe(true);

      // Viewer can only view
      expect(meetsPermissionLevel(Permission.VIEWER, Permission.OWNER)).toBe(false);
      expect(meetsPermissionLevel(Permission.VIEWER, Permission.EDITOR)).toBe(false);
      expect(meetsPermissionLevel(Permission.VIEWER, Permission.VIEWER)).toBe(true);
    });
  });

  describe("resolveFeature", () => {
    it("should return true for explicitly granted features", () => {
      const features = { comment: true, view_history: false };
      expect(resolveFeature("viewer", Feature.COMMENT, features)).toBe(true);
    });

    it("should return false for explicitly denied features", () => {
      const features = { comment: false, view_history: true };
      expect(resolveFeature("owner", Feature.COMMENT, features)).toBe(false);
    });

    it("should fall back to defaults when no explicit feature set", () => {
      // Owner defaults
      expect(resolveFeature("owner", Feature.COMMENT)).toBe(true);
      expect(resolveFeature("owner", Feature.VIEW_HISTORY)).toBe(true);
      expect(resolveFeature("owner", Feature.VIEW_AUDIT)).toBe(true);
      expect(resolveFeature("owner", Feature.MANAGE_EXTENSIONS)).toBe(true);

      // Editor defaults
      expect(resolveFeature("editor", Feature.COMMENT)).toBe(true);
      expect(resolveFeature("editor", Feature.VIEW_HISTORY)).toBe(true);
      expect(resolveFeature("editor", Feature.VIEW_AUDIT)).toBe(true);
      expect(resolveFeature("editor", Feature.MANAGE_EXTENSIONS)).toBe(false);

      // Viewer defaults
      expect(resolveFeature("viewer", Feature.COMMENT)).toBe(false);
      expect(resolveFeature("viewer", Feature.VIEW_HISTORY)).toBe(false);
      expect(resolveFeature("viewer", Feature.VIEW_AUDIT)).toBe(false);
      expect(resolveFeature("viewer", Feature.MANAGE_EXTENSIONS)).toBe(false);
    });

    it("should return false for undefined role", () => {
      expect(resolveFeature(undefined, Feature.COMMENT)).toBe(false);
      expect(resolveFeature(undefined, Feature.VIEW_HISTORY)).toBe(false);
    });

    it("should return false for invalid role", () => {
      expect(resolveFeature("invalid", Feature.COMMENT)).toBe(false);
    });

    it("should prioritise explicit features over defaults", () => {
      // Editor normally has comment, but explicit deny overrides
      expect(resolveFeature("editor", Feature.COMMENT, { comment: false })).toBe(false);
      // Viewer normally doesn't have comment, but explicit grant overrides
      expect(resolveFeature("viewer", Feature.COMMENT, { comment: true })).toBe(true);
    });
  });

  describe("canComment", () => {
    it("should return true for owner and editor by default", () => {
      expect(canComment("owner")).toBe(true);
      expect(canComment("editor")).toBe(true);
    });

    it("should return false for viewer by default", () => {
      expect(canComment("viewer")).toBe(false);
    });

    it("should respect explicit feature grants", () => {
      expect(canComment("viewer", { comment: true })).toBe(true);
      expect(canComment("editor", { comment: false })).toBe(false);
    });

    it("should return false for undefined role", () => {
      expect(canComment(undefined)).toBe(false);
    });
  });

  describe("canViewHistory", () => {
    it("should return true for owner and editor by default", () => {
      expect(canViewHistory("owner")).toBe(true);
      expect(canViewHistory("editor")).toBe(true);
    });

    it("should return false for viewer by default", () => {
      expect(canViewHistory("viewer")).toBe(false);
    });

    it("should respect explicit feature grants", () => {
      expect(canViewHistory("viewer", { view_history: true })).toBe(true);
      expect(canViewHistory("editor", { view_history: false })).toBe(false);
    });

    it("should return false for undefined role", () => {
      expect(canViewHistory(undefined)).toBe(false);
    });
  });

  describe("canViewAudit", () => {
    it("should return true for owners and editors by default", () => {
      expect(canViewAudit("owner")).toBe(true);
      expect(canViewAudit("editor")).toBe(true);
      expect(canViewAudit("viewer")).toBe(false);
    });

    it("should respect explicit feature grants", () => {
      expect(canViewAudit("editor", { view_audit: true })).toBe(true);
      expect(canViewAudit("owner", { view_audit: false })).toBe(false);
    });

    it("should return false for undefined role", () => {
      expect(canViewAudit(undefined)).toBe(false);
    });
  });

  describe("canManageExtensions", () => {
    it("should return true for owner only by default", () => {
      expect(canManageExtensions("owner")).toBe(true);
      expect(canManageExtensions("editor")).toBe(false);
      expect(canManageExtensions("viewer")).toBe(false);
    });

    it("should respect explicit feature grants", () => {
      expect(canManageExtensions("editor", { manage_extensions: true })).toBe(true);
      expect(canManageExtensions("owner", { manage_extensions: false })).toBe(false);
    });

    it("should return false for undefined role", () => {
      expect(canManageExtensions(undefined)).toBe(false);
    });
  });

  describe("Feature Defaults by Role", () => {
    it("should give owner all features by default", () => {
      expect(canComment("owner")).toBe(true);
      expect(canViewHistory("owner")).toBe(true);
      expect(canViewAudit("owner")).toBe(true);
      expect(canManageExtensions("owner")).toBe(true);
    });

    it("should give editors collaboration and activity features by default", () => {
      expect(canComment("editor")).toBe(true);
      expect(canViewHistory("editor")).toBe(true);
      expect(canViewAudit("editor")).toBe(true);
      expect(canManageExtensions("editor")).toBe(false);
    });

    it("should give viewer no features by default", () => {
      expect(canComment("viewer")).toBe(false);
      expect(canViewHistory("viewer")).toBe(false);
      expect(canViewAudit("viewer")).toBe(false);
      expect(canManageExtensions("viewer")).toBe(false);
    });
  });
});
