import Alpine from "alpinejs";

declare global {
  interface Window {
    Alpine: typeof Alpine;
  }
}

window.Alpine = Alpine;
Alpine.start();
