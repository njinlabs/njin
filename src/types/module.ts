export interface Module {
  boot: () => void | Promise<void>;
}
