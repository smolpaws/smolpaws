import json
from pathlib import Path
import tempfile
import unittest
from render import load_story, timestamp


class StoryTests(unittest.TestCase):
    def test_timestamps(self):
        self.assertEqual(timestamp(3661.234), '01:01:01,234')
        self.assertEqual(timestamp(59.9999), '00:01:00,000')

    def test_story(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            ((root / 'slide.png').resolve()).touch()
            path = root / 'story.json'
            scene = {'image': 'slide.png', 'narration': 'A short explanation.', 'source': 'commit:path:L1'}
            path.write_text(json.dumps({'scenes': [scene]}))
            self.assertEqual(load_story(path)[0]['image'], (root / 'slide.png').resolve())
            for key in scene:
                broken = dict(scene)
                del broken[key]
                path.write_text(json.dumps({'scenes': [broken]}))
                with self.assertRaises(ValueError):
                    load_story(path)
            for narration in ['x' * 241, 'two\nlines', '']:
                path.write_text(json.dumps({'scenes': [dict(scene, narration=narration)]}))
                with self.assertRaises(ValueError):
                    load_story(path)
            for invalid in [[], {}, {'scenes': []}, {'scenes': [None]}, {'scenes': [dict(scene, image='missing.png')]}]:
                path.write_text(json.dumps(invalid))
                with self.assertRaises(ValueError):
                    load_story(path)


if __name__ == '__main__':
    unittest.main()
