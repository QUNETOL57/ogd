import csv
import io
import json
import unittest
import zipfile

from app.importer import iter_mifitness_zip


class ImporterTest(unittest.TestCase):
    def test_reads_core_metrics_sleep_and_workouts(self):
        fitness = io.StringIO()
        writer = csv.DictWriter(fitness, fieldnames=["Uid", "Sid", "Key", "Time", "Value", "UpdateTime"])
        writer.writeheader()
        writer.writerows([
            {"Key": "steps", "Time": "1736000000", "Value": json.dumps({"time": 1736000000, "steps": 42})},
            {"Key": "heart_rate", "Time": "1736000000", "Value": json.dumps({"time": 1736000000, "bpm": 81})},
            {"Key": "sleep", "Time": "1736000000", "Value": json.dumps({"bedtime": 1735970000, "wake_up_time": 1736000000, "bed_duration": 18000, "sleep_deep_duration": 80})},
        ])
        sport = io.StringIO()
        sport_writer = csv.DictWriter(sport, fieldnames=["Uid", "Sid", "Key", "Time", "Category", "Value", "UpdateTime"])
        sport_writer.writeheader()
        sport_writer.writerow({"Key": "running", "Category": "running", "Time": "1736001000", "Value": json.dumps({"start_time": 1736001000, "end_time": 1736001600, "duration": 600, "calories": 55, "avg_hrm": 125})})
        archive = io.BytesIO()
        with zipfile.ZipFile(archive, "w", zipfile.ZIP_DEFLATED) as z:
            z.writestr("x_hlth_center_fitness_data.csv", fitness.getvalue())
            z.writestr("x_hlth_center_sport_record.csv", sport.getvalue())
        archive.seek(0)

        rows = list(iter_mifitness_zip(archive, "not-needed-for-plain-zip"))
        metrics = [row for kind, row in rows if kind == "metric"]
        workouts = [row for kind, row in rows if kind == "workout"]

        self.assertEqual({m["key"] for m in metrics}, {"steps", "heart_rate", "sleep_minutes", "sleep_deep", "sleep_light", "sleep_rem"})
        self.assertEqual(next(m["value"] for m in metrics if m["key"] == "steps"), 42)
        self.assertEqual(len(workouts), 1)
        self.assertEqual(workouts[0]["calories"], 55)
        self.assertEqual(workouts[0]["avg_hr"], 125)


if __name__ == "__main__":
    unittest.main()
