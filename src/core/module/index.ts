export type ModuleReturn = {
  spin?: () => Promise<void> | void;
};

export interface Module<Return> {
  (): Return;
  init: () => Promise<ModuleReturn> | ModuleReturn;
}

export const makeModule = <Return>(creator: () => Module<Return>) => {
  return creator();
};
