"""ORCID API client — author verification and profile data."""
import logging
import re
from typing import Dict, List, Optional

from .core import API_RATE_LIMITS, APIResponse, BaseAPIClient

logger = logging.getLogger(__name__)


class ORCIDClient(BaseAPIClient):
    """ORCID public API v3.0 client."""

    def __init__(self):
        super().__init__(
            api_name="orcid",
            base_url="https://pub.orcid.org/v3.0",
            rate_limit_config=API_RATE_LIMITS["orcid"],
        )

    def _default_headers(self) -> Dict[str, str]:
        headers = super()._default_headers()
        headers["Accept"] = "application/json"
        return headers

    # ── Public API ────────────────────────────────────────────────────────────

    async def search_person(
        self,
        name: str = "",
        affiliation: str = "",
        email: str = "",
    ) -> APIResponse:
        """Search ORCID for a person by name, affiliation, or email."""
        query_parts: List[str] = []

        if name:
            clean = re.sub(r"[^\w\s\-]", "", name).strip()
            parts = clean.split()
            if len(parts) >= 2:
                query_parts.append(
                    f'given-names:"{parts[0]}" AND family-name:"{" ".join(parts[1:])}"'
                )
            elif clean:
                query_parts.append(f'text:"{clean}"')

        if affiliation:
            clean = re.sub(r"[^\w\s\-]", "", affiliation).strip()
            if clean:
                query_parts.append(f'affiliation-org-name:"{clean}"')

        if email and "@" in email:
            query_parts.append(f'email:"{email.strip().lower()}"')

        if not query_parts:
            return APIResponse(
                success=False, data=None,
                error="At least one search parameter required",
                source=self.api_name,
            )

        response = await self._make_request(
            "GET", "search",
            params={"q": " AND ".join(query_parts), "rows": 20},
        )
        if response.success and response.data:
            response.data = self._parse_search_results(response.data)
        return response

    async def get_person_details(self, orcid_id: str) -> APIResponse:
        """Get full person record by ORCID iD."""
        clean = self._normalise_orcid(orcid_id)
        if not clean:
            return APIResponse(
                success=False, data=None,
                error=f"Invalid ORCID iD: {orcid_id}",
                source=self.api_name,
            )
        response = await self._make_request("GET", f"{clean}/person")
        if response.success and response.data:
            response.data = self._parse_person_details(response.data)
        return response

    # ── Helpers ───────────────────────────────────────────────────────────────

    @staticmethod
    def _normalise_orcid(raw: str) -> Optional[str]:
        if not raw:
            return None
        cleaned = raw.replace("https://orcid.org/", "").replace("http://orcid.org/", "").strip()
        pattern = r"^\d{4}-\d{4}-\d{4}-\d{3}[\dX]$"
        if re.match(pattern, cleaned):
            return cleaned
        digits = re.sub(r"[^\dX]", "", cleaned)
        if len(digits) == 16:
            formatted = f"{digits[:4]}-{digits[4:8]}-{digits[8:12]}-{digits[12:]}"
            if re.match(pattern, formatted):
                return formatted
        return None

    @staticmethod
    def _parse_search_results(data: Dict) -> List[Dict]:
        results: List[Dict] = []
        try:
            for item in data.get("result", []):
                person: Dict = {}
                orcid_info = item.get("orcid-identifier", {})
                person["orcid_id"] = orcid_info.get("path", "")
                person["orcid_uri"] = orcid_info.get("uri", "")

                name_info = (item.get("person") or {}).get("name") or {}
                given = (name_info.get("given-names") or {}).get("value", "")
                family = (name_info.get("family-name") or {}).get("value", "")
                credit = (name_info.get("credit-name") or {}).get("value", "")
                person["given_names"] = given
                person["family_name"] = family
                person["credit_name"] = credit
                person["full_name"] = credit or f"{given} {family}".strip()

                inst_raw = (item.get("person") or {}).get("institution-name")
                if isinstance(inst_raw, list):
                    person["institutions"] = [i.get("value", "") for i in inst_raw]
                elif inst_raw:
                    person["institutions"] = [inst_raw.get("value", "")]
                else:
                    person["institutions"] = []

                results.append(person)
        except Exception as exc:
            logger.error("ORCIDClient: parse search results: %s", exc)
        return results

    @staticmethod
    def _parse_person_details(data: Dict) -> Dict:
        info: Dict = {}
        try:
            name = data.get("name") or {}
            info["given_names"] = (name.get("given-names") or {}).get("value", "")
            info["family_name"] = (name.get("family-name") or {}).get("value", "")
            info["credit_name"] = (name.get("credit-name") or {}).get("value", "")

            bio = data.get("biography") or {}
            info["biography"] = bio.get("content", "")

            kw_block = data.get("keywords") or {}
            info["keywords"] = [
                kw.get("content", "")
                for kw in kw_block.get("keyword", [])
                if isinstance(kw, dict)
            ]

            ext_ids: Dict[str, str] = {}
            for ext in (data.get("external-identifiers") or {}).get("external-identifier", []):
                if isinstance(ext, dict):
                    id_type = ext.get("external-id-type", "")
                    id_value = ext.get("external-id-value", "")
                    if id_type and id_value:
                        ext_ids[id_type] = id_value
            info["external_identifiers"] = ext_ids
        except Exception as exc:
            logger.error("ORCIDClient: parse person details: %s", exc)
        return info


# Module-level singleton
_orcid_client: Optional[ORCIDClient] = None


def get_orcid_client() -> ORCIDClient:
    global _orcid_client
    if _orcid_client is None:
        _orcid_client = ORCIDClient()
    return _orcid_client
