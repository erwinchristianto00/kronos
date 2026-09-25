"""Coaching could never write a review, and the tool never told it why.

Every COACHING cycle in the lane's history ended INVALID_MODEL_RESPONSE. The model's
own last words: "REVIEW write is blocked by a tool-side schema mismatch... Nine
attempts, the validator alternates between two errors... I can't see the schema."

Two causes, both here: the tool declared `review` as a bare {"type": "object"}, and the
handler raised bare KeyErrors. The validator itself is unchanged — what a valid review
IS was never the problem.
"""
import unittest

import astra_v8_runner as runner
from astra_canonical_v8 import AXES


def good_body():
    return {"axes": {a: "observed" for a in AXES}, "observedMechanism": "m",
            "requiredAction": "a", "exceptions": "e"}


class SchemaVisibilityTests(unittest.TestCase):
    """The model cannot comply with a shape it is not shown."""

    def schema(self):
        engine = type("E", (), {"PLAN_SCHEMA": {"parameters": {"properties": {"plan": {}}}}})()
        return runner.tool_schemas(engine)["astra_learn"]["parameters"]["properties"]

    def test_the_review_shape_is_declared_not_left_as_a_bare_object(self):
        review = self.schema()["review"]
        self.assertEqual(sorted(review["required"]), ["body", "evidenceId", "id"])
        self.assertIn("body", review["properties"])

    def test_the_review_body_names_its_exact_required_keys(self):
        body = self.schema()["review"]["properties"]["body"]
        self.assertEqual(sorted(body["required"]),
                         ["axes", "exceptions", "observedMechanism", "requiredAction"])

    def test_all_seven_axes_are_named_in_the_schema(self):
        """The model guessed `reviewAxes`; it had no way to learn the real key set."""
        text = self.schema()["review"]["properties"]["body"]["properties"]["axes"]["description"]
        for axis in AXES:
            self.assertIn(axis, text)

    def test_the_publish_shape_is_declared_too(self):
        lesson = self.schema()["lesson"]
        self.assertIn("lessonId", lesson["required"])
        self.assertIn("check", lesson["required"])


class ActionableErrorTests(unittest.TestCase):
    """An error the model cannot act on is the same as no error at all."""

    def test_a_missing_field_is_named_instead_of_raising_a_bare_key_error(self):
        with self.assertRaises(ValueError) as caught:
            runner.require_fields({"evidenceId": "e", "body": {}}, ("id", "evidenceId", "body"), "review")
        self.assertIn("id", str(caught.exception))
        self.assertIn("missing required field", str(caught.exception))

    def test_a_non_object_is_explained_rather_than_crashing(self):
        with self.assertRaises(ValueError):
            runner.require_fields("not an object", ("id",), "review")

    def test_an_extra_body_key_is_named_as_the_thing_to_remove(self):
        """The validator rejects ANY extra key with the same sentence as a missing one.
        That is precisely what the model could not distinguish."""
        body = {**good_body(), "requiredCheck": "guessed"}
        with self.assertRaises(ValueError) as caught:
            runner.explain_review_body(body)
        message = str(caught.exception)
        self.assertIn("requiredCheck", message)
        self.assertIn("not permitted", message)

    def test_a_missing_axis_is_named(self):
        body = good_body()
        del body["axes"]["ENTRY_TIMING"]
        with self.assertRaises(ValueError) as caught:
            runner.explain_review_body(body)
        self.assertIn("ENTRY_TIMING", str(caught.exception))

    def test_a_guessed_axis_key_is_named(self):
        body = good_body()
        body["axes"]["MADE_UP_AXIS"] = "x"
        with self.assertRaises(ValueError) as caught:
            runner.explain_review_body(body)
        self.assertIn("MADE_UP_AXIS", str(caught.exception))

    def test_a_blank_axis_value_is_named(self):
        body = good_body()
        body["axes"]["EXIT_DECISION"] = "   "
        with self.assertRaises(ValueError) as caught:
            runner.explain_review_body(body)
        self.assertIn("EXIT_DECISION", str(caught.exception))

    def test_a_correct_body_passes_untouched(self):
        body = good_body()
        self.assertIs(runner.explain_review_body(body), body)

    def test_the_optional_classification_is_still_permitted(self):
        body = {**good_body(), "outcomeClassification": "GOOD_PROCESS_BAD_OUTCOME"}
        self.assertIs(runner.explain_review_body(body), body)

    def test_the_validator_itself_is_unchanged(self):
        """This release explains the contract; it does not relax it."""
        import inspect
        from astra_canonical_v8 import CanonicalBook
        source = inspect.getsource(CanonicalBook.review)
        self.assertIn("REVIEW requires seven axes, mechanism, required action and exceptions", source)
        self.assertIn('set(body) - required - {"outcomeClassification"}', source)


if __name__ == "__main__":
    unittest.main()
