export interface SystemSession {
  user: { name: string; username?: string; role: string; roleCode?: string };
  tenant: { name: string; environment: string };
  period: { accounting: string; business: string };
}

export async function fetchSystemSession(): Promise<SystemSession | null> {
  try {
    const response = await fetch("/api/system/session");
    if (!response.ok) {
      return null;
    }
    return await response.json() as SystemSession;
  } catch {
    return null;
  }
}
