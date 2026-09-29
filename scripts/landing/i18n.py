"""Strict, versionable translation inputs. No silently English third-language pages."""
import hashlib
import json
import pathlib
import re

LOCALES = ('en', 'ru', 'pt', 'es', 'vi', 'id', 'fil')
TAGS = {'en': 'en', 'ru': 'ru', 'pt': 'pt-BR', 'es': 'es', 'vi': 'vi', 'id': 'id', 'fil': 'fil'}
NAMES = {'en': 'English', 'ru': 'Русский', 'pt': 'Português', 'es': 'Español', 'vi': 'Tiếng Việt', 'id': 'Bahasa Indonesia', 'fil': 'Filipino'}

def load_translations(source):
    translations = {'en': {k: v[0] for k, v in source.items()}, 'ru': {k: v[1] for k, v in source.items()}}
    for locale in LOCALES[2:]:
        translations[locale] = json.loads((pathlib.Path(__file__).parent / 'locales' / (locale + '.json')).read_text())
    source_hashes = json.loads((pathlib.Path(__file__).parent / 'locales/source.json').read_text())['englishSha256']
    assert source_hashes == {k: hashlib.sha256(v.encode()).hexdigest() for k, v in translations['en'].items()}, 'English copy changed: synchronize all translations and update source.json explicitly'
    for locale, bundle in translations.items():
        assert bundle.keys() == translations['en'].keys(), (locale, 'missing', translations['en'].keys() - bundle.keys(), 'extra', bundle.keys() - translations['en'].keys())
        for key, value in bundle.items():
            assert isinstance(value, str) and value.strip(), (locale, key, 'empty')
            assert sorted(re.findall(r'\{\w+\}', value)) == sorted(re.findall(r'\{\w+\}', translations['en'][key])), (locale, key, 'placeholders')
            # Copy is trusted, authored markup; do not let an accidental script close escape embedded JSON.
            assert '</script' not in value.lower(), (locale, key, 'script close')
            tags = re.findall(r'<[^>]*>', value)
            assert all(t in ('<span class="tag-accent">', '</span>', '<em>', '</em>') for t in tags), (locale, key, 'unexpected markup')
    return translations
