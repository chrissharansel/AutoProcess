

import requests
import json
from requests.auth import HTTPBasicAuth

# Oracle PO API configuration
API_URL = "https://isptst.petmate.com:8500/apex/rest/get/podetails/"

USERNAME = "exlify_ai"
PASSWORD = "YOUR_PASSWORD"

PO_NUMBER = "382745"

params = {
    "po_number": PO_NUMBER
}

try:
    response = requests.get(
        API_URL,
        params=params,
        auth=HTTPBasicAuth(USERNAME, PASSWORD),
        headers={"Accept": "application/json"},
        timeout=60
    )

    print("HTTP Status:", response.status_code)

    response.raise_for_status()

    data = response.json()

    print("\nAPI Response:")
    print(json.dumps(data, indent=4))

    with open("po_response.json", "w", encoding="utf-8") as file:
        json.dump(data, file, indent=4, ensure_ascii=False)

    print("\nResponse saved to po_response.json")

    # Display important PO header details
    print("\n--- PO HEADER ---")
    for field in [
        "po_number",
        "supplier",
        "supplier_number",
        "supplier_id",
        "supplier_site_id",
        "supplier_site",
        "currency",
        "terms",
        "po_status"
    ]:
        print(f"{field}: {data.get(field)}")

    # Display PO lines
    print("\n--- PO LINES ---")

    for line in data.get("lines", []):
        print(
            f"Line: {line.get('line_num')} | "
            f"Item: {line.get('item_number')} | "
            f"Description: {line.get('item_description')} | "
            f"Quantity: {line.get('item_qty')} | "
            f"Unit Price: {line.get('unit_price')} | "
            f"Amount: {line.get('line_amount')} | "
            f"Account: {line.get('default_distribution_account')}"
        )

except requests.exceptions.HTTPError as e:
    print("HTTP Error:", e)
    print("Response:", response.text)

except requests.exceptions.RequestException as e:
    print("Connection Error:", e)

except ValueError:
    print("The API did not return valid JSON.")
    print(response.text)
