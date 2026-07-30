from __future__ import annotations

import io
import json
import unittest

from PIL import Image

from image_metadata import EXIF_USER_COMMENT, convert_output


SAMPLE = {
    "schemaVersion": 1,
    "model": "wai_v17",
    "preset": "square",
    "width": 1024,
    "height": 1024,
    "positive": "1girl, blue eyes",
    "negative": "lowres",
    "seed": 42,
    "steps": 24,
    "cfg": 5,
    "sampler": "euler_ancestral",
    "scheduler": "normal",
    "loras": [{"id": "style", "strength": 0.8}],
    "upscale": False,
    "outputFormat": "png",
}


def source_png() -> bytes:
    output = io.BytesIO()
    Image.new("RGB", (8, 8), (20, 40, 60)).save(output, "PNG")
    return output.getvalue()


class MetadataTest(unittest.TestCase):
    def test_png_contains_generation_metadata(self) -> None:
        data, content_type = convert_output(source_png(), "png", SAMPLE)
        self.assertEqual(content_type, "image/png")
        with Image.open(io.BytesIO(data)) as image:
            embedded = json.loads(image.text["chatos"])
            self.assertEqual(embedded["seed"], 42)
            self.assertEqual(embedded["positive"], "1girl, blue eyes")
            self.assertIn("Seed: 42", image.text["parameters"])

    def test_webp_contains_generation_exif(self) -> None:
        data, content_type = convert_output(source_png(), "webp", SAMPLE)
        self.assertEqual(content_type, "image/webp")
        with Image.open(io.BytesIO(data)) as image:
            comment = image.getexif()[EXIF_USER_COMMENT]
            self.assertTrue(comment.startswith(b"UNICODE\x00"))
            embedded = json.loads(comment[8:].decode("utf-16-be"))
            self.assertEqual(embedded["model"], "wai_v17")
            self.assertEqual(embedded["loras"][0]["strength"], 0.8)


if __name__ == "__main__":
    unittest.main()
