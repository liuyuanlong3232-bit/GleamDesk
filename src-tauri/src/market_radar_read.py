"""Read saved radar outputs only. Never import collectors or request market data."""
import datetime
import json
import math
import re
from pathlib import Path

RADAR_SYMBOLS = {
    "sz000426": "000426.SZ", "sz000960": "000960.SZ",
    "nf_AG0": "AG.SHF", "nf_SN0": "SN.SHF",
}
RADAR_HEADER = ["名称", "代码", "最新", "涨跌", "成交量", "成交额", "数据时间", "质量"]


def radar_number(value, percent=False):
    pattern = r"[+-]?(?:\d{1,3}(?:,\d{3})+|\d+)(?:\.\d+)?"
    if percent:
        pattern += "%"
    if not re.fullmatch(pattern, value):
        return None
    result = float(value.removesuffix("%").replace(",", ""))
    return result if math.isfinite(result) else None


def radar_timestamp(value):
    try:
        parsed = datetime.datetime.fromisoformat(value.replace("Z", "+00:00"))
        return parsed.isoformat() if parsed.tzinfo is not None else None
    except (ValueError, TypeError):
        return None


def parse_radar_table(text):
    """Accept one exact, contiguous table; never extract from narrative or alerts."""
    lines = text.splitlines()
    found = []
    for index, line in enumerate(lines):
        cells = [cell.strip() for cell in line.strip().strip("|").split("|")]
        if cells != RADAR_HEADER:
            continue
        if index + 1 >= len(lines):
            return []
        separator = [cell.strip() for cell in lines[index + 1].strip().strip("|").split("|")]
        if len(separator) != len(RADAR_HEADER) or not all(re.fullmatch(r":?-{3,}:?", cell) for cell in separator):
            return []
        found.append(index + 2)
    if len(found) != 1:
        return []
    quotes = {}; duplicates = set()
    for line in lines[found[0]:found[0] + 30]:
        if not line.strip().startswith("|") or not line.strip().endswith("|"):
            break
        cells = [cell.strip() for cell in line.strip()[1:-1].split("|")]
        if len(cells) != len(RADAR_HEADER):
            return []
        _, source_symbol, raw_price, raw_change, _, _, collected, quality = cells
        if source_symbol not in RADAR_SYMBOLS:
            continue
        if source_symbol in quotes:
            duplicates.add(source_symbol)
        price = radar_number(raw_price)
        collected_at = radar_timestamp(collected)
        quotes[source_symbol] = None
        if quality != "DATA_OK" or price is None or price <= 0 or collected_at is None:
            continue
        quotes[source_symbol] = {
            "symbol": RADAR_SYMBOLS[source_symbol], "sourceSymbol": source_symbol,
            "price": price, "changePct": radar_number(raw_change, percent=True),
            "quoteAt": None, "collectedAt": collected_at,
            "dataType": "intraday", "source": "VPS / 新浪盘中雷达",
        }
    return [quote for symbol, quote in quotes.items() if quote is not None and symbol not in duplicates]


def bounded_radar_file(path, parent, limit=256000):
    resolved = path.resolve()
    if not resolved.is_relative_to(parent.resolve()) or not resolved.is_file() or resolved.stat().st_size > limit:
        raise ValueError("radar file unavailable")
    return resolved.read_text(encoding="utf-8")


def read_cn_futures_main_contracts(root):
    """Read existing collector evidence independently of intraday radar availability."""
    try:
        raw = json.loads(bounded_radar_file(root / "collection_status.json", root, 512000))
        if not isinstance(raw, dict) or not isinstance(raw.get("records"), list) or len(raw["records"]) > 100:
            return []
        collected = raw.get("collected_at_bjt")
        if not isinstance(collected, str) or radar_timestamp(collected) is None:
            return []
        collected_day = datetime.datetime.fromisoformat(collected.replace("Z", "+00:00")).astimezone(datetime.timezone(datetime.timedelta(hours=8))).date()
        result = []
        for row in raw["records"]:
            if not isinstance(row, dict):
                continue
            continuous, contract = row.get("continuous_code"), row.get("ts_code")
            match = re.fullmatch(r"([A-Z]+)\.(SHF|DCE|ZCE)", continuous) if isinstance(continuous, str) else None
            if not match or not isinstance(contract, str) or not re.fullmatch(match[1] + r"\d{4}\." + match[2], contract):
                continue
            status = row.get("mapping_status")
            if status not in ("对应关系已确认", "对应关系未确认"):
                continue
            day = row.get("trade_date")
            if not isinstance(day, str) or not re.fullmatch(r"\d{8}", day):
                continue
            try:
                mapping_day = datetime.datetime.strptime(day, "%Y%m%d").date()
            except ValueError:
                continue
            if mapping_day > collected_day:
                continue
            result.append({"continuousSymbol": continuous, "contractSymbol": contract,
                           "mappingDate": mapping_day.isoformat(), "confirmed": status == "对应关系已确认",
                           "collectedAt": collected, "source": "VPS / 国内期货采集状态"})
        return result
    except (OSError, ValueError, TypeError):
        return []


def read_saved_radar(root):
    unavailable = {"status": "unavailable", "quotes": [], "mainContracts": []}
    try:
        evidence = root / "evidence"
        markers = sorted(evidence.glob("radar-run-*.txt"), reverse=True)
        if not markers:
            return unavailable
        marker = markers[0]
        if not re.fullmatch(r"radar-run-\d{8}T\d{6}Z\.txt", marker.name):
            return unavailable
        values = dict(line.split("=", 1) for line in bounded_radar_file(marker, evidence, 4096).splitlines() if "=" in line)
        if values.get("MODE") != "RADAR" or values.get("TRADING_DAY_STATUS") != "OPEN":
            return unavailable
        directory = Path(values.get("OUTPUT_DIRECTORY", ""))
        if directory != root / "alerts" / marker.name.replace("radar-run-", "cron-").removesuffix(".txt"):
            return unavailable
        quotes = parse_radar_table(bounded_radar_file(directory / "intraday-radar.txt", root / "alerts"))
        completed_at = datetime.datetime.strptime(marker.stem.removeprefix("radar-run-"), "%Y%m%dT%H%M%SZ").replace(tzinfo=datetime.timezone.utc)
        quotes = [q for q in quotes if abs((datetime.datetime.fromisoformat(q["collectedAt"]) - completed_at).total_seconds()) <= 300]
        # This JSON supplies mapping evidence only; its historical closes never replace radar prices.
        mappings = []
        try:
            refs = json.loads(bounded_radar_file(root / "state/daily-references-current.json", root / "state", 512000))
            if refs.get("schema_version") == 1:
                for item in refs.get("daily_references", [])[:30]:
                    if not isinstance(item, dict) or item.get("symbol") not in ("nf_AG0", "nf_SN0"):
                        continue
                    continuous = RADAR_SYMBOLS[item["symbol"]]
                    mapping = item.get("roll_mapping", {})
                    if not isinstance(mapping, dict):
                        continue
                    day = completed_at.astimezone(datetime.timezone(datetime.timedelta(hours=8))).strftime("%Y%m%d")
                    contract = mapping.get(day)
                    prefix = continuous.split(".")[0]
                    if isinstance(contract, str) and re.fullmatch(prefix + r"\d{4}\.SHF", contract):
                        mappings.append({"continuousSymbol": continuous, "contractSymbol": contract, "mappingDate": day[:4] + "-" + day[4:6] + "-" + day[6:]})
        except (ValueError, OSError, TypeError, AttributeError):
            pass
        return {"status": "available" if quotes else "unavailable", "quotes": quotes, "mainContracts": mappings}
    except (ValueError, OSError, TypeError, AttributeError):
        return unavailable
