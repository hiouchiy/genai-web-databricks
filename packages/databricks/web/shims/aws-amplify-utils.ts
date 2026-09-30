/** 認証画面の文言辞書は不要（Databricks SSO のログイン画面を使うため） */
export const I18n = {
  putVocabularies: (_v?: unknown) => {},
  setLanguage: (_l?: string) => {},
  get: (key: string) => key,
};
export const Hub = { listen: () => () => {} };
