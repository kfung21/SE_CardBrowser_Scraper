# FFTCG Card Scraper

A Node.js scraper for the official [Final Fantasy Trading Card Game card browser](https://fftcg.square-enix-games.com/en/card-browser). Extracts card data and images with proper parsing of ability text icons.

## Features

- Scrapes card data from the official Square Enix FFTCG card browser
- Downloads high-resolution card images
- Parses ability text with icon notation (element costs, crystal costs, dull/tap, etc.)
- Supports filtering by set, element, type, rarity, category, cost, and more
- Incremental saving - progress is saved every 10 cards
- Incremental image downloads - images download as cards are scraped
- Configurable via JSON config file or CLI arguments

## Installation

```bash
npm install playwright
npx playwright install chromium
```

## Usage

### Basic Usage

```bash
# Scrape with a config file
node se_card_browser.js --config opus1_config.json

# Scrape a specific set
node se_card_browser.js --set "Opus I"

# Run with visible browser (for debugging)
node se_card_browser.js --config myconfig.json --visible

# Skip image downloads
node se_card_browser.js --set "Opus I" --no-images

# Skip detailed card scraping (codes only)
node se_card_browser.js --set "Opus I" --no-details
```

### CLI Options

| Option | Description |
|--------|-------------|
| `--config <file>` | Load configuration from JSON file |
| `--set <name>` | Filter by set name (e.g., "Opus I", "Crystal Dominion") |
| `--rarity <code>` | Filter by rarity (C, R, H, L, S, B, PR) |
| `--category <name>` | Filter by category (VII, X, FFT, etc.) |
| `--visible` | Run browser in visible mode (not headless) |
| `--no-images` | Skip downloading card images |
| `--no-details` | Skip scraping card details (only get codes) |

## Configuration

Create a JSON config file for more control:

```json
{
    "output": {
        "directory": "./opus1_cards",
        "downloadImages": true,
        "saveJson": true,
        "jsonFilename": "cards.json",
        "imageSubdir": "images"
    },
    "filters": {
        "sets": ["Opus I"],
        "elements": ["Fire", "Ice"],
        "types": ["Forward", "Backup"],
        "rarities": ["L", "H"],
        "categories": ["VII", "X"],
        "costs": [3, 4, 5],
        "flags": ["exburst"]
    },
    "scraping": {
        "includeCardDetails": true,
        "delayBetweenCards": 150,
        "delayBetweenPages": 500,
        "headless": true,
        "timeout": 60000
    },
    "images": {
        "quality": "full",
        "concurrent": 5
    }
}
```

### Filter Options

| Filter | Values |
|--------|--------|
| `sets` | "Opus I", "Opus II", ..., "Crystal Dominion", "Gunslinger in the Abyss", etc. |
| `elements` | "Fire", "Ice", "Wind", "Earth", "Lightning", "Water", "Light", "Dark" |
| `types` | "Forward", "Backup", "Summon", "Monster", "Crystal" |
| `rarities` | "C" (Common), "R" (Rare), "H" (Hero), "L" (Legend), "S" (Starter), "B" (Boss), "PR" (Promo) |
| `flags` | "special", "exburst", "multi" (generic) |

## Output Format

### Card JSON Structure

```json
{
  "scraped_at": "2026-01-19T05:00:00.000Z",
  "filters": { "sets": ["Opus I"] },
  "total": 219,
  "complete": true,
  "cards": [
    {
      "code": "1-003C",
      "name": "Red Mage",
      "type": "Backup",
      "job": "Standard Unit",
      "element": "Fire",
      "cost": 2,
      "power": 0,
      "rarity": "Common",
      "category": "III",
      "set": "Opus I",
      "abilities": "[F][1][Dull]: Choose 1 Forward. It cannot block this turn.",
      "imageUrl": "https://fftcg.cdn.sewest.net/images/cards/full/1-003C_eg.jpg"
    }
  ]
}
```

### Icon Notation

The scraper converts HTML icon elements to bracketed text notation:

| Icon | Output | Meaning |
|------|--------|---------|
| Fire | `[F]` | Fire element/cost |
| Ice | `[I]` | Ice element/cost |
| Wind | `[W]` | Wind element/cost |
| Earth | `[E]` | Earth element/cost |
| Lightning | `[L]` | Lightning element/cost |
| Water | `[A]` | Water/Aqua element/cost |
| Light | `[Lt]` | Light element/cost |
| Dark | `[D]` | Dark element/cost |
| Crystal | `[C]` | Crystal/CP cost |
| Number | `[1]`, `[2]`, etc. | Numbered cost |
| Dull | `[Dull]` | Tap/Dull action |
| Special | `[S]` | Special ability cost |
| EX Burst | `[EX]` | EX Burst marker |

### Special Ability Formats

**Priming** (XVI mechanic):
```
*Priming "Ifrit (XVI)" [F][F][3]* Clive gains all the special abilities...
```

**Limit Break** (XII mechanic):
```
*Limit Break 2* When Vaan enters the field, if you control 4 or more Wind Characters...
```

Italic text (keywords, card references) is wrapped in `*asterisks*`.

## Output Files

After scraping, you'll find in your output directory:

```
output/
├── cards.json           # Complete card data
├── cards_partial.json   # Partial save (deleted on completion)
├── card_codes.json      # Just the card codes (saved first)
└── images/
    ├── 1-001H.jpg
    ├── 1-002R.jpg
    └── ...
```

## Examples

### Scrape Opus I

```bash
node se_card_browser.js --set "Opus I"
```

### Scrape all Fire Legends

```json
{
    "output": { "directory": "./fire_legends" },
    "filters": {
        "elements": ["Fire"],
        "rarities": ["L"]
    }
}
```

```bash
node se_card_browser.js --config fire_legends.json
```

### Scrape Final Fantasy VII cards only

```json
{
    "output": { "directory": "./ff7_cards" },
    "filters": {
        "categories": ["VII"]
    }
}
```

## Error Handling

- Progress is saved every 10 cards to `*_partial.json`
- Images download incrementally (won't lose progress if interrupted)
- Card codes are saved immediately before detail scraping begins
- Failed image downloads are logged but don't stop the scraper

## Requirements

- Node.js 18+
- Playwright

## License

MIT

## Disclaimer

This tool is for personal use. Card data and images are property of Square Enix. Please respect their terms of service.
