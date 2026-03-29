export const LOCAL_USER_ID = "local";

export const LOCAL_USER = {
  id: LOCAL_USER_ID,
  name: "Local User",
  email: "local@localhost",
  emailVerified: true,
  image: null,
  createdAt: new Date(0),
  updatedAt: new Date(0),
};

export const LOCAL_SESSION = {
  id: "local-session",
  userId: LOCAL_USER_ID,
  token: "local",
  expiresAt: new Date(Date.now() + 365 * 24 * 60 * 60 * 1000),
  ipAddress: null,
  userAgent: null,
  createdAt: new Date(0),
  updatedAt: new Date(0),
};

export function isNoAuthMode(): boolean {
  return process.env.VEKTOR_NO_AUTH === "1";
}
