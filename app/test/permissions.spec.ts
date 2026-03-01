import { describe, expect, it } from "bun:test";
import {
  hasPermission,
  canView,
  canEdit,
  isOwner,
  canAccessSettings,
  hasFeature,
  canComment,
  canViewHistory,
  canViewAudit,
  canManageExtensions,
} from "../src/composeables/usePermissions.ts";

describe("Permission Utilities", () => {
  describe("hasPermission", () => {
    it("should return true when user has exact permission level", () => {
      expect(hasPermission("viewer", "viewer")).toBe(true);
      expect(hasPermission("editor", "editor")).toBe(true);
      expect(hasPermission("owner", "owner")).toBe(true);
    });

    it("should return true when user has higher permission level", () => {
      expect(hasPermission("owner", "editor")).toBe(true);
      expect(hasPermission("owner", "viewer")).toBe(true);
      expect(hasPermission("editor", "viewer")).toBe(true);
    });

    it("should return false when user has lower permission level", () => {
      expect(hasPermission("viewer", "editor")).toBe(false);
      expect(hasPermission("viewer", "owner")).toBe(false);
      expect(hasPermission("editor", "owner")).toBe(false);
    });

    it("should return false when userRole is undefined", () => {
      expect(hasPermission(undefined, "viewer")).toBe(false);
      expect(hasPermission(undefined, "editor")).toBe(false);
      expect(hasPermission(undefined, "owner")).toBe(false);
    });

    it("should return false for invalid role strings", () => {
      expect(hasPermission("invalid", "viewer")).toBe(false);
      expect(hasPermission("guest", "viewer")).toBe(false);
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
      expect(hasPermission("owner", "owner")).toBe(true);
      expect(hasPermission("owner", "editor")).toBe(true);
      expect(hasPermission("owner", "viewer")).toBe(true);

      // Editor can do editor, viewer
      expect(hasPermission("editor", "owner")).toBe(false);
      expect(hasPermission("editor", "editor")).toBe(true);
      expect(hasPermission("editor", "viewer")).toBe(true);

      // Viewer can only view
      expect(hasPermission("viewer", "owner")).toBe(false);
      expect(hasPermission("viewer", "editor")).toBe(false);
      expect(hasPermission("viewer", "viewer")).toBe(true);
    });
  });

  describe("hasFeature", () => {
    it("should return true for explicitly granted features", () => {
      const features = { comment: true, view_history: false };
      expect(hasFeature("viewer", "comment", features)).toBe(true);
    });

    it("should return false for explicitly denied features", () => {
      const features = { comment: false, view_history: true };
      expect(hasFeature("owner", "comment", features)).toBe(false);
    });

    it("should fall back to defaults when no explicit feature set", () => {
      // Owner defaults
      expect(hasFeature("owner", "comment")).toBe(true);
      expect(hasFeature("owner", "view_history")).toBe(true);
      expect(hasFeature("owner", "view_audit")).toBe(true);
      expect(hasFeature("owner", "manage_extensions")).toBe(true);

      // Editor defaults
      expect(hasFeature("editor", "comment")).toBe(true);
      expect(hasFeature("editor", "view_history")).toBe(true);
      expect(hasFeature("editor", "view_audit")).toBe(false);
      expect(hasFeature("editor", "manage_extensions")).toBe(false);

      // Viewer defaults
      expect(hasFeature("viewer", "comment")).toBe(false);
      expect(hasFeature("viewer", "view_history")).toBe(false);
      expect(hasFeature("viewer", "view_audit")).toBe(false);
      expect(hasFeature("viewer", "manage_extensions")).toBe(false);
    });

    it("should return false for undefined role", () => {
      expect(hasFeature(undefined, "comment")).toBe(false);
      expect(hasFeature(undefined, "view_history")).toBe(false);
    });

    it("should return false for invalid role", () => {
      expect(hasFeature("invalid", "comment")).toBe(false);
    });

    it("should prioritise explicit features over defaults", () => {
      // Editor normally has comment, but explicit deny overrides
      expect(hasFeature("editor", "comment", { comment: false })).toBe(false);
      // Viewer normally doesn't have comment, but explicit grant overrides
      expect(hasFeature("viewer", "comment", { comment: true })).toBe(true);
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
    it("should return true for owner only by default", () => {
      expect(canViewAudit("owner")).toBe(true);
      expect(canViewAudit("editor")).toBe(false);
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

    it("should give editor comment and view_history by default", () => {
      expect(canComment("editor")).toBe(true);
      expect(canViewHistory("editor")).toBe(true);
      expect(canViewAudit("editor")).toBe(false);
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
