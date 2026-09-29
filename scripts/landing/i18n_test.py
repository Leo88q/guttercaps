import copy
import json
import pathlib
import shutil
import tempfile
import unittest
from unittest.mock import patch
from content import T
from i18n import LOCALES, load_translations


class TranslationGateTest(unittest.TestCase):
    def test_all_seven_complete(self):
        bundles = load_translations(T)
        self.assertEqual(set(bundles), set(LOCALES))
        for bundle in bundles.values():
            self.assertEqual(set(bundle), set(T))

    def test_english_amendment_requires_sync(self):
        changed = copy.deepcopy(T)
        changed['hero.sub'] = ('Changed source', changed['hero.sub'][1])
        with self.assertRaisesRegex(AssertionError, 'English copy changed'):
            load_translations(changed)

    def check_bad_translation(self, mutate):
        with tempfile.TemporaryDirectory() as temp:
            root = pathlib.Path(temp)
            shutil.copytree(pathlib.Path(__file__).parent / 'locales', root / 'locales')
            path = root / 'locales/pt.json'
            data = json.loads(path.read_text())
            mutate(data)
            path.write_text(json.dumps(data))
            with patch('i18n.__file__', str(root / 'i18n.py')):
                with self.assertRaises(AssertionError):
                    load_translations(T)

    def test_missing_key(self):
        self.check_bad_translation(lambda d: d.pop('hero.sub'))

    def test_empty_text(self):
        self.check_bad_translation(lambda d: d.update({'hero.sub': ' '}))

    def test_missing_parameter(self):
        self.check_bad_translation(lambda d: d.update({'pack.hard': 'Missing parameters'}))

    def test_forbidden_markup(self):
        self.check_bad_translation(lambda d: d.update({'hero.sub': '<img src=x onerror=alert(1)>'}))

    def test_script_escape(self):
        self.check_bad_translation(lambda d: d.update({'hero.sub': '</script><script>alert(1)</script>'}))


if __name__ == '__main__':
    unittest.main()
