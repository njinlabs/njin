export type AuthGuard<User = any, Token = any> = {
  user: User;
  token: Token;
};
