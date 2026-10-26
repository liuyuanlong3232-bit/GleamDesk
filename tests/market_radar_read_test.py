"""Synthetic saved-file tests; no SSH or market requests."""
import importlib.util
import json
from pathlib import Path
import tempfile
import unittest

spec = importlib.util.spec_from_file_location("market_radar_read", Path(__file__).parents[1] / "src-tauri/src/market_radar_read.py")
reader = importlib.util.module_from_spec(spec)
spec.loader.exec_module(reader)
HEADER = "| 名称 | 代码 | 最新 | 涨跌 | 成交量 | 成交额 | 数据时间 | 质量 |\n|---|---|---|---|---|---|---|---|\n"
ROW = "| 测试 | nf_AG0 | 14,000.00 | -2.98% | 1 | 2 | 2026-10-15T07:04:02+00:00 | DATA_OK |\n"


class RadarReadTests(unittest.TestCase):
    def test_embedded_reader_returns_local_database_and_sidecar_without_live_radar(self):
        import contextlib
        import io
        import sqlite3
        from unittest.mock import patch
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            macro = root / "macro"
            status_root = macro / "meta/cn_futures"
            status_root.mkdir(parents=True)
            saved = {"collected_at_bjt": "2026-10-17T08:04:00+08:00", "records": [
                {"continuous_code": "C.DCE", "ts_code": "C2701.DCE", "trade_date": "20261016", "mapping_status": "对应关系已确认"}
            ]}
            (status_root / "collection_status.json").write_text(json.dumps(saved), encoding="utf-8")
            database = macro / "hermes.db"
            with contextlib.closing(sqlite3.connect(database)) as connection:
                connection.execute('CREATE TABLE yahoo_futures ("品種","代碼","日期","最新價","抓取日","日漲跌幅%")')
                connection.execute('CREATE TABLE cn_futures (name,symbol,date,close,fetched_at,pre_close,change_pct,unit,source)')
                connection.execute('INSERT INTO cn_futures VALUES (?,?,?,?,?,?,?,?,?)', ("玉米", "C2701.DCE", "20261016", 2300, "2026-10-17 08:04", 2200, 4.5, "元/吨", "Tushare API"))
                connection.commit()
            original = database.read_bytes()
            source = (Path(__file__).parents[1] / "src-tauri/src/agriculture.rs").read_text(encoding="utf-8")
            query = source.split('const MARKET_QUERY:&str=r#"', 1)[1].split('"#;', 1)[0]
            script = source.split('const SCRIPT:&str=r#"', 1)[1].split('"#;', 1)[0]
            script = script.replace("__MARKET_QUERY__", query).replace("__RADAR_READER__", Path(spec.origin).read_text(encoding="utf-8"))
            connect = sqlite3.connect
            def saved_connection(destination, **kwargs):
                self.assertEqual(destination, database.as_uri() + "?mode=ro")
                return connect(database.as_uri() + "?mode=ro", **kwargs)
            output = io.StringIO()
            with patch.object(sqlite3, "connect", saved_connection), contextlib.redirect_stdout(output):
                exec(compile(script, "embedded-synthetic-reader", "exec"), {"CONFIG":{"dataRoot":str(macro),"radarRoot":"","sshAlias":"synthetic"}})
            result = json.loads(output.getvalue())
            self.assertEqual(result["radar"]["status"], "unavailable")
            self.assertEqual(result["radar"]["mainContracts"][0]["contractSymbol"], "C2701.DCE")
            self.assertEqual(result["chinaFutures"][0]["history"][0]["sourceDate"], "2026-10-16")
            self.assertEqual(database.read_bytes(), original)

    def test_collector_sidecar_supplies_confirmed_and_unconfirmed_relations(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            path = root / "collection_status.json"
            saved = {"collected_at_bjt": "2026-10-17T08:04:00+08:00", "records": [
                {"continuous_code": "C.DCE", "ts_code": "C2611.DCE", "trade_date": "20261016", "mapping_status": "对应关系未确认"},
                {"continuous_code": "C.DCE", "ts_code": "C2701.DCE", "trade_date": "20261016", "mapping_status": "对应关系已确认"},
            ]}
            path.write_text(json.dumps(saved, ensure_ascii=False), encoding="utf-8")
            before = path.read_bytes()
            result = reader.read_cn_futures_main_contracts(root)
            self.assertEqual(len(result), 2)
            self.assertFalse(result[0]["confirmed"])
            self.assertTrue(result[1]["confirmed"])
            self.assertEqual(result[1]["mappingDate"], "2026-10-16")
            self.assertEqual(result[1]["collectedAt"], saved["collected_at_bjt"])
            self.assertEqual(path.read_bytes(), before)
            self.assertEqual(reader.read_saved_radar(root)["status"], "unavailable")

    def test_collector_sidecar_missing_or_malformed_stays_unavailable(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            self.assertEqual(reader.read_cn_futures_main_contracts(root), [])
            for value in ["{broken", "[]", '{"records":null}', '{"collected_at_bjt":"invalid","records":[]}']:
                (root / "collection_status.json").write_text(value, encoding="utf-8")
                self.assertEqual(reader.read_cn_futures_main_contracts(root), [])

    def test_collector_sidecar_rejects_invalid_relationships_without_exposing_other_fields(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            valid = {"continuous_code": "C.DCE", "ts_code": "C2701.DCE", "trade_date": "20261016", "mapping_status": "对应关系已确认"}
            for patch in [{"ts_code": "A2701.DCE"}, {"trade_date": "20260230"}, {"trade_date": "20261018"}, {"mapping_status": "OK"}]:
                saved = {"collected_at_bjt": "2026-10-17T08:04:00+08:00", "records": [{**valid, **patch}]}
                (root / "collection_status.json").write_text(json.dumps(saved), encoding="utf-8")
                self.assertEqual(reader.read_cn_futures_main_contracts(root), [])

    def test_extract_only_exact_table(self):
        result = reader.parse_radar_table("报告\n" + HEADER + ROW + "\n异常观察：nf_SN0=99999\n")
        self.assertEqual(len(result), 1)
        self.assertEqual(result[0]["symbol"], "AG.SHF")
        self.assertEqual(result[0]["price"], 14000)
        self.assertEqual(result[0]["changePct"], -2.98)
        self.assertIsNone(result[0]["quoteAt"])

    def test_header_separator_or_column_drift_fails_closed(self):
        for text in [HEADER.replace("最新", "最新价") + ROW, HEADER.replace("---", "--") + ROW, HEADER + ROW.replace("| 测试", "| 额外 | 测试"), HEADER + ROW + HEADER + ROW]:
            self.assertEqual(reader.parse_radar_table(text), [])

    def test_missing_invalid_or_duplicate_data_stays_empty(self):
        for changed in [ROW.replace("DATA_OK", "DATA_UNAVAILABLE"), ROW.replace("14,000.00", "NaN"), ROW.replace("14,000.00", "0"), ROW.replace("+00:00", ""), ROW + ROW, ROW.replace("nf_AG0", "hf_XAG")]:
            self.assertEqual(reader.parse_radar_table(HEADER + changed), [])

    def test_missing_change_is_not_zero(self):
        self.assertIsNone(reader.parse_radar_table(HEADER + ROW.replace("-2.98%", "—"))[0]["changePct"])

    def test_read_completed_saved_files_and_mapping_without_execution(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp); (root / "evidence").mkdir(); (root / "state").mkdir()
            directory = root / "alerts/cron-20261015T070401Z"; directory.mkdir(parents=True)
            marker = root / "evidence/radar-run-20261015T070401Z.txt"
            marker.write_text(f"MODE=RADAR\nTRADING_DAY_STATUS=OPEN\nOUTPUT_DIRECTORY={directory}\n", encoding="utf-8")
            (directory / "intraday-radar.txt").write_text(HEADER + ROW, encoding="utf-8")
            (root / "state/daily-references-current.json").write_text(json.dumps({"schema_version": 1, "daily_references": [{"symbol": "nf_AG0", "roll_mapping": {"20261015": "AG2612.SHF"}, "closes": [99999]}]}), encoding="utf-8")
            data = reader.read_saved_radar(root)
            self.assertEqual(data["quotes"][0]["price"], 14000)
            self.assertEqual(data["mainContracts"][0]["contractSymbol"], "AG2612.SHF")
            # Newest broken output must not silently fall back to an older successful run.
            (root / "evidence/radar-run-20261015T070701Z.txt").write_text("MODE=RADAR\nOUTPUT_DIRECTORY=/tmp/other\n", encoding="utf-8")
            self.assertEqual(reader.read_saved_radar(root)["quotes"], [])

    def test_reader_is_static_and_contains_no_external_calls(self):
        import ast
        source = Path(spec.origin).read_text(encoding="utf-8")
        tree = ast.parse(source)
        imports = {alias.name.split(".")[0] for node in ast.walk(tree) if isinstance(node, ast.Import) for alias in node.names}
        self.assertFalse(imports & {"requests", "subprocess", "os", "tushare", "socket"})
        self.assertNotIn("write_text", source)
        self.assertNotIn("write_bytes", source)


if __name__ == "__main__":
    unittest.main()
