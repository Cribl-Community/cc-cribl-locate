export {};

declare global {
  interface CriblUser {
    id: string;
    username: string;
    email?: string;
    firstName?: string;
    lastName?: string;
    initials?: string;
  }

  interface Window {
    /** Base URL for all Cribl API calls, e.g. https://localhost:9000/api/v1 */
    CRIBL_API_URL: string;
    /** The base path the app is mounted at, e.g. /app-ui/my-app */
    CRIBL_BASE_PATH: string;
    getCriblUser: () => Promise<CriblUser>;
  }
}
