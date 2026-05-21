export const env = {
  apiURL: import.meta.env.VITE_API_URL || "http://localhost:4571",
  socketURL: import.meta.env.VITE_SOCKET_URL || "http://localhost:4571",
  currentDomain: import.meta.env.VITE_CURRENT_DOMAIN || "localhost",
};
