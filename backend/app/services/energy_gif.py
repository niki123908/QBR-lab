import base64
from io import BytesIO
from PIL import Image


def encode_energy_gif(frames, durations=None):
    if durations is not None and (len(durations) != len(frames) or any(d < 10 or d > 2000 or d % 10 for d in durations)):
        raise ValueError("Invalid frame durations.")
    images = []
    try:
        for frame in frames:
            raw = base64.b64decode(frame, validate=True)
            with Image.open(BytesIO(raw)) as source:
                if source.format != "PNG" or source.width > 1200 or source.height > 1200:
                    raise ValueError("Frames must be PNG images up to 1200 × 1200.")
                if images and source.size != images[0].size:
                    raise ValueError("All frames must have the same size.")
                images.append(source.convert("RGB").quantize(colors=256))
        if not images:
            raise ValueError("No frames supplied.")
        output = BytesIO()
        images[0].save(output, format="GIF", save_all=True, append_images=images[1:],
                       duration=durations if durations is not None else 2000, loop=0, disposal=2, optimize=False)
        return output.getvalue()
    finally:
        for image in images:
            image.close()
