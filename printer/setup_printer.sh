#!/bin/bash

echo "Searching for Epson M3170 printers..."
echo ""

# Detect printer URIs
NETWORK_URI=$(lpinfo -v | grep dnssd | grep -i m3170 | head -n 1 | awk '{print $2}')
USB_IPP_URI=$(lpinfo -v | grep "(USB)" | grep ipp | head -n 1 | awk '{print $2}')
USB_URI=$(lpinfo -v | grep usb | grep -i epson | head -n 1 | awk '{print $2}')

OPTIONS=()
URIS=()

echo "Available printer connections:"
echo ""

INDEX=1

# Driverless network
if [ -n "$NETWORK_URI" ]; then
    echo "$INDEX) Driverless Network (IPP)"
    echo "   $NETWORK_URI"
    echo ""
    OPTIONS+=("$INDEX")
    URIS+=("$NETWORK_URI")
    ((INDEX++))
fi

# IPP over USB
if [ -n "$USB_IPP_URI" ]; then
    echo "$INDEX) USB (IPP over USB)"
    echo "   $USB_IPP_URI"
    echo ""
    OPTIONS+=("$INDEX")
    URIS+=("$USB_IPP_URI")
    ((INDEX++))
fi

# Classic USB backend
if [ -n "$USB_URI" ]; then
    echo "$INDEX) USB Direct"
    echo "   $USB_URI"
    echo ""
    OPTIONS+=("$INDEX")
    URIS+=("$USB_URI")
    ((INDEX++))
fi

echo "$INDEX) Exit"
echo ""

read -p "Select printer connection: " OPTION

if [ "$OPTION" == "$INDEX" ]; then
    echo "Exiting..."
    exit 0
fi

SELECTED_URI="${URIS[$((OPTION-1))]}"

if [ -z "$SELECTED_URI" ]; then
    echo "Invalid selection."
    exit 1
fi

echo ""
echo "Using printer:"
echo "$SELECTED_URI"
echo ""

PRINTER_NAME="Epson_M3170"

echo "Removing old printer configuration..."
sudo lpadmin -x $PRINTER_NAME 2>/dev/null

echo "Adding printer..."

sudo lpadmin -p $PRINTER_NAME \
-E \
-v "$SELECTED_URI" \
-m everywhere

echo "Setting default printer..."
sudo lpadmin -d $PRINTER_NAME

echo "Restarting CUPS..."
sudo systemctl restart cups

echo ""
echo "Printer setup complete!"
echo ""

lpstat -p