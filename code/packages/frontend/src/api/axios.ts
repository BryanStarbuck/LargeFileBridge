// Single axios instance. In production the AuthBridge registers getToken (OpenAuthFederated);
// in localhost dev mode no token is attached and the backend authenticates the dev user.
import axios from "axios";
import { toast } from "sonner";

export const http = axios.create({ baseURL: "/api", withCredentials: true });

type TokenGetter = () => Promise<string | null>;
let getToken: TokenGetter | null = null;
let reloadSession: (() => Promise<void>) | null = null;

export function registerAuthBridge(g: TokenGetter, reload: () => Promise<void>): void {
  getToken = g;
  reloadSession = reload;
}

http.interceptors.request.use(async (config) => {
  if (getToken) {
    // Token mint failed — log and proceed unauthenticated (backend may still accept cookie/dev auth).
    // NOTE: this file is imported BY clientLog, so use console.error here to avoid a circular import.
    const token = await getToken().catch((e) => {
      console.error("[axios.getToken]", e);
      return null;
    });
    if (token) config.headers.Authorization = `Bearer ${token}`;
  }
  return config;
});

http.interceptors.response.use(
  (r) => r,
  async (error) => {
    const status = error?.response?.status;
    if (status === 401 && reloadSession && !error.config.__retried) {
      error.config.__retried = true;
      // Re-hydrate failed — log but still retry the request (it will surface its own 401 if truly dead).
      await reloadSession().catch((e) => {
        console.error("[axios.reloadSession]", e);
      });
      return http.request(error.config);
    }
    if (status === 403) toast.error("You don't have permission to do that.");
    return Promise.reject(error);
  },
);

// Unwrap the { ok, data } envelope; throw the error string on failure.
export async function unwrap<T>(p: Promise<{ data: { ok: boolean; data?: T; error?: string } }>): Promise<T> {
  const res = await p;
  if (!res.data.ok) throw new Error(res.data.error || "request failed");
  return res.data.data as T;
}
