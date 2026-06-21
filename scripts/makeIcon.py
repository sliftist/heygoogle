from PIL import Image, ImageDraw
import os

SIZE = 144
SCALE = 8
W = SIZE * SCALE
OUT = os.path.join(os.path.dirname(__file__), "..", "assets", "icon-144.png")

bg = (66, 133, 244, 255)
white = (255, 255, 255, 255)

img = Image.new("RGBA", (W, W), (0, 0, 0, 0))
draw = ImageDraw.Draw(img)

radius = (SIZE // 2) * SCALE
draw.rounded_rectangle([(0, 0), (W, W)], radius=radius, fill=bg)

tv_left, tv_top = 24 * SCALE, 36 * SCALE
tv_right, tv_bot = 120 * SCALE, 96 * SCALE
draw.rounded_rectangle(
    [(tv_left, tv_top), (tv_right, tv_bot)],
    radius=8 * SCALE,
    outline=white,
    width=5 * SCALE,
)

stand_y = tv_bot
foot_y = stand_y + 14 * SCALE
mid_x = (tv_left + tv_right) // 2
draw.line([(mid_x - 6 * SCALE, stand_y), (mid_x - 22 * SCALE, foot_y)], fill=white, width=5 * SCALE)
draw.line([(mid_x + 6 * SCALE, stand_y), (mid_x + 22 * SCALE, foot_y)], fill=white, width=5 * SCALE)
draw.line([(mid_x - 26 * SCALE, foot_y), (mid_x + 26 * SCALE, foot_y)], fill=white, width=5 * SCALE)

sx = (tv_left + tv_right) / 2
sy = (tv_top + tv_bot) / 2
play = [
    (sx - 9 * SCALE, sy - 14 * SCALE),
    (sx - 9 * SCALE, sy + 14 * SCALE),
    (sx + 15 * SCALE, sy),
]
draw.polygon(play, fill=white)

img = img.resize((SIZE, SIZE), Image.LANCZOS)
img.save(OUT, "PNG")
print(f"wrote {OUT} ({img.size[0]}x{img.size[1]})")
