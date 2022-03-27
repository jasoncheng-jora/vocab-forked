import path from 'path';

import glob from 'fast-glob';
import {
  TranslationsByKey,
  UserConfig,
  LoadedTranslation,
  LanguageTarget,
  LanguageName,
} from '@vocab/types';
import chalk from 'chalk';

import { trace } from './logger';
import {
  defaultTranslationDirSuffix,
  Fallback,
  getAltLanguageFilePath,
  getAltLanguages,
  getDevTranslationFileGlob,
} from './utils';

export function getUniqueKey(key: string, namespace: string) {
  return `${key}.${namespace}`;
}

export function mergeWithDevLanguageTranslation({
  translation,
  devTranslation,
}: {
  translation: TranslationsByKey;
  devTranslation: TranslationsByKey;
}) {
  // Only use keys from the dev translation
  const keys = Object.keys(devTranslation);
  const newLanguage: TranslationsByKey = {};

  for (const key of keys) {
    if (translation[key]) {
      newLanguage[key] = {
        message: translation[key].message,
        description: devTranslation[key].description,
      };
    }
  }

  return newLanguage;
}

function getLanguageFallbacks({
  languages,
}: {
  languages: Array<LanguageTarget>;
}) {
  const languageFallbackMap = new Map<LanguageName, LanguageName>();

  for (const lang of languages) {
    if (lang.extends) {
      languageFallbackMap.set(lang.name, lang.extends);
    }
  }

  return languageFallbackMap;
}

export function getLanguageHierarchy({
  languages,
}: {
  languages: Array<LanguageTarget>;
}) {
  const hierarchyMap = new Map<LanguageName, Array<LanguageName>>();
  const fallbacks = getLanguageFallbacks({ languages });

  for (const lang of languages) {
    const langHierarchy = [];
    let currLang = lang.extends;

    while (currLang) {
      langHierarchy.push(currLang);

      currLang = fallbacks.get(currLang);
    }

    hierarchyMap.set(lang.name, langHierarchy);
  }

  return hierarchyMap;
}

export function getFallbackLanguageOrder({
  languages,
  languageName,
  devLanguage,
  fallbacks,
}: {
  languages: LanguageTarget[];
  languageName: string;
  devLanguage: string;
  fallbacks: Fallback;
}) {
  const languageHierarchy = getLanguageHierarchy({ languages }).get(
    languageName,
  );

  if (!languageHierarchy) {
    throw new Error(`Missing language hierarchy for ${languageName}`);
  }

  const fallbackLanguageOrder: Array<string> = [languageName];

  if (fallbacks !== 'none') {
    fallbackLanguageOrder.unshift(...languageHierarchy.reverse());

    if (fallbacks === 'all' && fallbackLanguageOrder[0] !== devLanguage) {
      fallbackLanguageOrder.unshift(devLanguage);
    }
  }

  return fallbackLanguageOrder;
}

function getNamespaceByFilePath(
  relativePath: string,
  { translationsDirectorySuffix = defaultTranslationDirSuffix }: UserConfig,
) {
  let namespace = path
    .dirname(relativePath)
    .replace(/^src\//, '')
    .replace(/\//g, '_');

  if (namespace.endsWith(translationsDirectorySuffix)) {
    namespace = namespace.slice(0, -translationsDirectorySuffix.length);
  }

  return namespace;
}

function printValidationError(...params: unknown[]) {
  // eslint-disable-next-line no-console
  console.error(chalk.red('Error loading translation:'), ...params);
}

function getTranslationsFromFile(
  translations: unknown,
  { isAltLanguage, filePath }: { isAltLanguage: boolean; filePath: string },
): { $namespace: unknown; keys: TranslationsByKey } {
  if (!translations || typeof translations !== 'object') {
    throw new Error(
      `Unable to read translation file ${filePath}. Translations must be an object`,
    );
  }
  const { $namespace, ...keys } = translations as TranslationsByKey;
  if (isAltLanguage && $namespace) {
    printValidationError(
      `Found $namespace in alt language file in ${filePath}. $namespace is only used in the dev language and will be ignored.`,
    );
  }
  if (!isAltLanguage && $namespace && typeof $namespace !== 'string') {
    printValidationError(
      `Found non-string $namespace in language file in ${filePath}. $namespace must be a string.`,
    );
  }
  const validKeys: TranslationsByKey = {};
  for (const [translationKey, translation] of Object.entries(keys)) {
    if (typeof translation === 'string') {
      printValidationError(
        `Found string for a translation "${translationKey}" in ${filePath}. Translation must be an object of the format {mesage: string}.`,
      );
      continue;
    }
    if (!translation) {
      printValidationError(
        `Found empty translation "${translationKey}" in ${filePath}. Translation must be an object of the format {mesage: string}.`,
      );
      continue;
    }
    if (!translation.message || typeof translation.message !== 'string') {
      printValidationError(
        `No message found for translation "${translationKey}" in ${filePath}. Translation must be an object of the format {mesage: string}.`,
      );
      continue;
    }
    validKeys[translationKey] = translation;
  }
  return { $namespace, keys: validKeys };
}

export function loadAltLanguageFile(
  {
    filePath,
    languageName,
    devTranslation,
    fallbacks,
  }: {
    filePath: string;
    languageName: string;
    devTranslation: TranslationsByKey;
    fallbacks: Fallback;
  },
  { devLanguage, languages }: UserConfig,
): TranslationsByKey {
  const altLanguageTranslation = {};

  const fallbackLanguageOrder = getFallbackLanguageOrder({
    languages,
    languageName,
    devLanguage,
    fallbacks,
  });

  trace(
    `Loading alt language file with precedence: ${fallbackLanguageOrder
      .slice()
      .reverse()
      .join(' -> ')}`,
  );

  for (const fallbackLanguage of fallbackLanguageOrder) {
    if (fallbackLanguage !== devLanguage) {
      try {
        const altFilePath = getAltLanguageFilePath(filePath, fallbackLanguage);
        delete require.cache[altFilePath];

        const translationFile = require(altFilePath);
        const { keys: fallbackLanguageTranslation } = getTranslationsFromFile(
          translationFile,
          {
            filePath: altFilePath,
            isAltLanguage: true,
          },
        );
        Object.assign(
          altLanguageTranslation,
          mergeWithDevLanguageTranslation({
            translation: fallbackLanguageTranslation,
            devTranslation,
          }),
        );
      } catch (e) {
        trace(`Missing alt language file ${getAltLanguageFilePath(
          filePath,
          fallbackLanguage,
        )}
        `);
      }
    } else {
      Object.assign(altLanguageTranslation, devTranslation);
    }
  }

  return altLanguageTranslation;
}

export function loadTranslation(
  {
    filePath,
    fallbacks,
  }: {
    filePath: string;
    fallbacks: Fallback;
  },
  userConfig: UserConfig,
): LoadedTranslation {
  trace(
    `Loading translation file in "${fallbacks}" fallback mode: "${filePath}"`,
  );

  const languageSet: Record<
    string,
    Record<string, { message: string; description?: string | undefined }>
  > = {};

  delete require.cache[filePath];
  const translationContent = require(filePath);
  const relativePath = path.relative(
    userConfig.projectRoot || process.cwd(),
    filePath,
  );
  const { $namespace, keys: devTranslation } = getTranslationsFromFile(
    translationContent,
    {
      filePath,
      isAltLanguage: false,
    },
  );
  const namespace: string =
    typeof $namespace === 'string'
      ? $namespace
      : getNamespaceByFilePath(relativePath, userConfig);

  trace(`Found file ${filePath}. Using namespace ${namespace}`);

  languageSet[userConfig.devLanguage] = devTranslation;
  const altLanguages = getAltLanguages(userConfig);
  for (const languageName of altLanguages) {
    languageSet[languageName] = loadAltLanguageFile(
      {
        filePath,
        languageName,
        devTranslation,
        fallbacks,
      },
      userConfig,
    );
  }

  return {
    filePath,
    keys: Object.keys(devTranslation),
    namespace,
    relativePath,
    languages: languageSet,
  };
}

export async function loadAllTranslations(
  {
    fallbacks,
    includeNodeModules,
  }: { fallbacks: Fallback; includeNodeModules: boolean },
  config: UserConfig,
): Promise<Array<LoadedTranslation>> {
  const { projectRoot, ignore = [] } = config;

  const translationFiles = await glob(getDevTranslationFileGlob(config), {
    ignore: includeNodeModules ? ignore : [...ignore, '**/node_modules/**'],
    absolute: true,
    cwd: projectRoot,
  });

  trace(`Found ${translationFiles.length} translation files`);

  const result = await Promise.all(
    translationFiles.map((filePath) =>
      loadTranslation({ filePath, fallbacks }, config),
    ),
  );
  const keys = new Set();
  for (const loadedTranslation of result) {
    for (const key of loadedTranslation.keys) {
      const uniqueKey = getUniqueKey(key, loadedTranslation.namespace);
      if (keys.has(uniqueKey)) {
        trace(`Duplicate keys found`);
        throw new Error(
          `Duplicate keys found. Key with namespace ${loadedTranslation.namespace} and key ${key} was found multiple times.`,
        );
      }
      keys.add(uniqueKey);
    }
  }
  return result;
}
